import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { ApiError, fail, ok } from "./envelope.js";
import { configFromRequest, generateJson } from "./llm.js";
import { parseUpload } from "./parse.js";
import { runGenerate } from "./pipeline.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const api = express.Router();

api.get("/health", (_req, res) => ok(res, { status: "up" }));

// "Test key" button in Settings. Proves the key and model work, nothing more.
api.get("/llm-check", async (req, res, next) => {
  try {
    const cfg = configFromRequest(req);
    const out = await generateJson('Return exactly {"pong": true}', z.object({ pong: z.boolean() }), cfg);
    ok(res, { provider: cfg.provider, model: cfg.model, reply: out });
  } catch (e) {
    next(e);
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

api.post("/parse", upload.fields([{ name: "spec", maxCount: 1 }, { name: "blueprint", maxCount: 1 }]), async (req, res, next) => {
  try {
    const files = req.files as { spec?: Express.Multer.File[]; blueprint?: Express.Multer.File[] } | undefined;
    const specFile = files?.spec?.[0];
    if (!specFile) throw new ApiError(400, "MISSING_SPEC", "Upload a course specification file in field 'spec'.");
    const spec = await parseUpload(specFile);
    const blueprint = files?.blueprint?.[0] ? await parseUpload(files.blueprint[0]) : null;
    ok(res, {
      spec: { filename: spec.filename, text: spec.text, tables: spec.tables },
      blueprint: blueprint ? { filename: blueprint.filename, text: blueprint.text, tables: blueprint.tables } : null,
    });
  } catch (e) {
    next(e);
  }
});

api.post("/generate", upload.fields([{ name: "spec", maxCount: 1 }, { name: "blueprint", maxCount: 1 }]), async (req, res, next) => {
  try {
    const cfg = configFromRequest(req);
    const files = req.files as { spec?: Express.Multer.File[]; blueprint?: Express.Multer.File[] } | undefined;
    const specFile = files?.spec?.[0];
    if (!specFile) throw new ApiError(400, "MISSING_SPEC", "Upload a course specification file in field 'spec'.");
    const result = await runGenerate({ specFile, blueprintFile: files?.blueprint?.[0], cfg });
    ok(res, { output: result.output, html: result.html });
  } catch (e) {
    next(e);
  }
});

app.use("/api/v1", api);
app.use("/api", (_req, res) => fail(res, 404, "NOT_FOUND", "No such route"));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) return fail(res, err.status, err.code, err.message);
  console.error("Unhandled:", err instanceof Error ? err.message : "unknown error"); // never log headers or keys
  fail(res, 500, "SERVER_ERROR", "Something went wrong on the server.");
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`API on http://localhost:${port}/api/v1`));
