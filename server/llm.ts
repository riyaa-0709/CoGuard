// The ONLY place that talks to an AI provider. Everything else calls generateJson().
// The key arrives per request from the browser. Never store it, log it or return it.
import { GoogleGenAI } from "@google/genai";
import type { Request } from "express";
import type { z, ZodTypeAny } from "zod";
import { ApiError } from "./envelope.js";

export type Provider = "gemini" | "openrouter" | "anthropic";
export type LlmConfig = { provider: Provider; key: string; model: string };

export const DEFAULT_MODELS = { gemini: "gemini-3.8-flash", openrouter: "google/gemini-2.5-flash", anthropic: "claude-sonnet-5-5" } as const;
const GEMINI_FALLBACK = "gemini-3.8-flash";

export function configFromRequest(req: Request): LlmConfig {
  const provider = String(req.header("x-llm-provider") ?? "").toLowerCase();
  const key = String(req.header("x-llm-key") ?? "").trim();
  const model = String(req.header("x-llm-model") ?? "").trim();
  if (!key) throw new ApiError(400, "MISSING_KEY", "Add your key in Settings.");
  if (provider !== "gemini" && provider !== "openrouter" && provider !== "anthropic") throw new ApiError(400, "BAD_PROVIDER", "Choose gemini, openrouter or anthropic in Settings.");
  return { provider, key, model: model || DEFAULT_MODELS[provider] };
}

function stripFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function mapGeminiError(e: any): never {
  const msg = String(e?.message ?? e?.error?.message ?? "unknown");
  const status = Number(e?.status ?? e?.code ?? e?.error?.code ?? 0);
  const lower = msg.toLowerCase();
  if (status === 429 || /resource.?exhausted|too many requests|quota/i.test(msg)) {
    throw new ApiError(429, "RATE_LIMITED", "The AI provider says too many requests. Wait a minute or switch model.");
  }
  if (status === 400 || status === 401 || status === 403 || /api key|permission|unauthor|invalid.?key/i.test(lower)) {
    throw new ApiError(401, "BAD_KEY", "The provider rejected this key or model. Check Settings.");
  }
  throw new ApiError(502, "PROVIDER_ERROR", "The AI provider failed. Try again.");
}

async function callProvider(prompt: string, cfg: LlmConfig): Promise<string> {
  if (cfg.provider === "gemini") {
    const run = async (model: string) => {
      try {
        const ai = new GoogleGenAI({ apiKey: cfg.key });
        const r = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: "application/json", temperature: 0 },
        });
        return r.text ?? "";
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        if (!/fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(msg)) throw e;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" },
          }),
        });
        if (res.status === 429) throw new ApiError(429, "RATE_LIMITED", "The AI provider says too many requests. Wait a minute or switch model.");
        if (res.status === 400 || res.status === 401 || res.status === 403) throw new ApiError(401, "BAD_KEY", "The provider rejected this key or model. Check Settings.");
        if (!res.ok) throw new ApiError(502, "PROVIDER_ERROR", `The AI provider failed (HTTP ${res.status}).`);
        const j: any = await res.json();
        return j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      }
    };
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await run(cfg.model);
      } catch (e: any) {
        last = e;
        const msg = String(e?.message ?? e?.error?.message ?? "unknown");
        console.error("Gemini error:", msg.slice(0, 240));
        if (cfg.model !== GEMINI_FALLBACK && /no longer available|not found|NOT_FOUND/i.test(msg)) {
          try {
            return await run(GEMINI_FALLBACK);
          } catch (e2: any) {
            last = e2;
          }
        }
        if (attempt === 0 && /fetch failed|ECONNRESET|ETIMEDOUT|socket|network/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        break;
      }
    }
    throw mapGeminiError(last);
  }
  if (cfg.provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 8000, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    if (r.status === 429 || r.status === 529) throw new ApiError(429, "RATE_LIMITED", "The AI provider says too many requests. Wait a minute or switch model.");
    if (r.status === 401 || r.status === 403) throw new ApiError(401, "BAD_KEY", "The provider rejected this key. Check Settings.");
    if (!r.ok) throw new ApiError(502, "PROVIDER_ERROR", `The AI provider failed (HTTP ${r.status}). Check the model name.`);
    const j: any = await r.json();
    return (j?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
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
  const j: any = await r.json();
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
