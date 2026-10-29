// The ONLY place that talks to an AI provider. Everything else calls generateJson().
// The key arrives per request from the browser. Never store it, log it or return it.
import dns from "node:dns";
import https from "node:https";
import { GoogleGenAI } from "@google/genai";
import type { Request } from "express";
import type { z, ZodTypeAny } from "zod";
import { ApiError } from "./envelope.js";

// Windows often black-holes IPv6 to Google; force IPv4 before any request.
dns.setDefaultResultOrder("ipv4first");

export type Provider = "gemini" | "openrouter" | "anthropic";
export type LlmConfig = { provider: Provider; key: string; model: string };

export const DEFAULT_MODELS = { gemini: "gemini-3.8-flash", openrouter: "google/gemini-2.5-flash", anthropic: "claude-sonnet-5-5" } as const;
const GEMINI_DEFAULT = DEFAULT_MODELS.gemini;
const REST_TIMEOUT_MS = 180_000;

export function configFromRequest(req: Request): LlmConfig {
  const provider = String(req.header("x-llm-provider") ?? "").toLowerCase();
  const key = String(req.header("x-llm-key") ?? "").trim();
  const model = String(req.header("x-llm-model") ?? "").trim();
  if (!key) throw new ApiError(400, "MISSING_KEY", "Add your key in Settings.");
  if (provider !== "gemini" && provider !== "openrouter" && provider !== "anthropic") throw new ApiError(400, "BAD_PROVIDER", "Choose gemini, openrouter or anthropic in Settings.");
  return { provider, key, model: resolveModel(provider, model) };
}

function resolveModel(provider: Provider, requested: string): string {
  const fallback = DEFAULT_MODELS[provider];
  const model = requested || fallback;
  if (provider === "gemini" && isRetiredGemini(model)) return GEMINI_DEFAULT;
  return model;
}

function isRetiredGemini(model: string): boolean {
  const m = model.toLowerCase().replace(/^models\//, "");
  return m === "gemini-2.5-flash" || m === "gemini-1.5-flash" || m === "gemini-1.5-pro";
}

function stripFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function netMsg(e: unknown): string {
  const err = e as Error & { cause?: unknown; code?: string };
  const cause = err.cause instanceof Error ? `${err.cause.name} ${err.cause.message}` : err.cause ? String(err.cause) : "";
  return `${err.code ?? ""} ${err.message ?? e} ${cause}`.replace(/\s+/g, " ").trim().slice(0, 180);
}

function mapGeminiError(e: unknown): never {
  const msg = netMsg(e);
  const status = Number((e as { status?: number })?.status ?? 0);
  if (status === 429 || /resource.?exhausted|too many requests|quota/i.test(msg)) {
    throw new ApiError(429, "RATE_LIMITED", "The AI provider says too many requests. Wait a minute or switch model.");
  }
  if (status === 400 || status === 401 || status === 403 || /api key|permission|unauthor|invalid.?key/i.test(msg)) {
    throw new ApiError(401, "BAD_KEY", "The provider rejected this key or model. Check Settings.");
  }
  throw new ApiError(502, "PROVIDER_ERROR", "The AI provider failed. Try again.");
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function textFromGemini(j: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] }): string {
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
}

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        family: 4,
        timeout: REST_TIMEOUT_MS,
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("REST timeout"));
    });
    req.on("error", (e) => reject(e));
    req.write(body);
    req.end();
  });
}

async function geminiRestOnce(model: string, prompt: string, key: string, thinkingBudget: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: "application/json",
    maxOutputTokens: 16384,
  };
  if (thinkingBudget >= 0) generationConfig.thinkingConfig = { thinkingBudget };
  const payload = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  });
  let res: { status: number; text: string };
  try {
    res = await httpsPost(url, payload, { "Content-Type": "application/json", "x-goog-api-key": key });
  } catch (e) {
    throw new Error(`REST network: ${netMsg(e)}`);
  }

  const body = res.text;
  if (res.status === 429 || res.status === 503) {
    const err = new Error(`Gemini HTTP ${res.status}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  if (res.status === 400 && /thinking/i.test(body)) throw new Error("thinking unsupported");
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new ApiError(401, "BAD_KEY", "The provider rejected this key or model. Check Settings.");
  if (res.status === 404 || /no longer available|not found/i.test(body)) {
    const err = new Error(`retired or missing model ${model}`);
    (err as { status?: number }).status = 404;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    console.error("Gemini HTTP", res.status, body.slice(0, 180));
    throw new ApiError(502, "PROVIDER_ERROR", `The AI provider failed (HTTP ${res.status}).`);
  }
  let parsed: { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("REST not JSON");
  }
  const text = textFromGemini(parsed);
  if (!text) throw new Error(`REST empty (${parsed.candidates?.[0]?.finishReason ?? "no text"})`);
  return text;
}

async function geminiRest(model: string, prompt: string, key: string): Promise<string> {
  let last: unknown;
  const budgets = [0, 256];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await geminiRestOnce(model, prompt, key, budgets[Math.min(attempt, budgets.length - 1)]);
    } catch (e) {
      last = e;
      if (e instanceof ApiError) throw e;
      const msg = netMsg(e);
      const status = Number((e as { status?: number }).status ?? 0);
      if (/thinking unsupported/i.test(msg)) {
        try {
          return await geminiRestOnce(model, prompt, key, -1);
        } catch (e2) {
          last = e2;
          if (e2 instanceof ApiError) throw e2;
        }
      }
      if (status === 429 || status === 503 || /REST empty|REST network|timeout/i.test(msg)) {
        console.error("Gemini REST retry:", model, msg);
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  const status = Number((last as { status?: number })?.status ?? 0);
  if (status === 429 || status === 503) throw new ApiError(429, "RATE_LIMITED", "The AI provider says too many requests. Wait a minute or switch model.");
  throw last instanceof Error ? last : new Error(String(last));
}

async function geminiSdk(model: string, prompt: string, key: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: key });
  const r = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  return r.text ?? "";
}

async function callGemini(prompt: string, cfg: LlmConfig): Promise<string> {
  const models = cfg.model === GEMINI_DEFAULT ? [GEMINI_DEFAULT] : [cfg.model, GEMINI_DEFAULT];
  let last: unknown;
  for (const model of models) {
    try {
      return await geminiRest(model, prompt, cfg.key);
    } catch (e) {
      last = e;
      if (e instanceof ApiError) throw e;
      console.error("Gemini REST failed:", model, netMsg(e));
      if (/retired or missing|no longer available|not found/i.test(netMsg(e)) && model !== GEMINI_DEFAULT) continue;
    }
    try {
      const sdkText = await withTimeout(geminiSdk(model, prompt, cfg.key), 8_000, "SDK timeout");
      if (sdkText) return sdkText;
    } catch (e) {
      last = e;
      if (e instanceof ApiError) throw e;
      console.error("Gemini SDK skipped:", model, netMsg(e));
    }
  }
  throw mapGeminiError(last);
}

async function callProvider(prompt: string, cfg: LlmConfig): Promise<string> {
  if (cfg.provider === "gemini") return callGemini(prompt, cfg);
  if (cfg.provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 8000, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    if (r.status === 429 || r.status === 529) throw new ApiError(429, "RATE_LIMITED", "The AI provider says too many requests. Wait a minute or switch model.");
    if (r.status === 401 || r.status === 403) throw new ApiError(401, "BAD_KEY", "The provider rejected this key. Check Settings.");
    if (!r.ok) throw new ApiError(502, "PROVIDER_ERROR", `The AI provider failed (HTTP ${r.status}). Check the model name.`);
    const j: { content?: { type: string; text?: string }[] } = await r.json();
    return (j?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (r.status === 429) throw new ApiError(429, "RATE_LIMITED", "The AI provider says too many requests. Wait a minute or switch model.");
  if (r.status === 401 || r.status === 403) throw new ApiError(401, "BAD_KEY", "The provider rejected this key. Check Settings.");
  if (!r.ok) throw new ApiError(502, "PROVIDER_ERROR", `The AI provider failed (HTTP ${r.status}). Check the model name.`);
  const j: { choices?: { message?: { content?: string } }[] } = await r.json();
  return j?.choices?.[0]?.message?.content ?? "";
}

export async function generateJson<S extends ZodTypeAny>(prompt: string, schema: S, cfg: LlmConfig): Promise<z.output<S>> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? "" : `\n\nYour previous answer was invalid: ${last}. Reply with valid JSON only.`;
    const raw = await callProvider(prompt + "\n\nReply with JSON only, no commentary." + suffix, cfg);
    try {
      const parsed = schema.safeParse(JSON.parse(stripFences(raw)));
      if (parsed.success) return parsed.data;
      last = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch {
      last = "not parseable JSON";
    }
  }
  throw new ApiError(502, "BAD_AI_OUTPUT", "The AI did not return valid JSON. Try again or pick another model.");
}
