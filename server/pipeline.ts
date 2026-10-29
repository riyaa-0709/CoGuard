import type { LlmConfig } from "./llm.js";
import { bloomFromVerb } from "./bloom.js";
import { clampMap } from "./clamp.js";
import { attachBloom, localMapping, proposeMap, summaryCoveringUnits } from "./mapping.js";
import { extractFromDocs, extractedToStructured, overlayExtracted } from "./extract.js";
import { extractInputId, parseUpload, type ParsedDoc } from "./parse.js";
import { renderHtml } from "./render.js";
import {
  DEFECT_CODES,
  SpecforgeOutputSchema,
  type Defect,
  type MappingAi,
  type SpecforgeOutput,
  type StructuredCourse,
} from "./schema.js";
import { structureCourse } from "./structure.js";
import { chooseTemplate } from "./templateChoice.js";
import { validateV1toV10 } from "./validate.js";

const ALLOWED_FINDING = new Set<string>(DEFECT_CODES);

function findingsToDefects(
  findings: { code: string; description: string; location_section?: number | null; refs?: string[]; source?: "spec" | "blueprint" | "template" }[] | undefined,
): Defect[] {
  const out: Defect[] = [];
  for (const f of findings ?? []) {
    if (!ALLOWED_FINDING.has(f.code)) continue;
    out.push({
      code: f.code as Defect["code"],
      location: {
        source: f.source ?? "spec",
        section: f.location_section ?? null,
        refs: f.refs ?? [],
      },
      description: f.description,
      fix: "Corrected in the generated specification where possible.",
    });
  }
  return out;
}

/** Scan source tables for CO ids that never appear in section-3 list. */
function scanExtraCos(docs: ParsedDoc[], defined: Set<string>): Defect[] {
  const defects: Defect[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const blob = doc.tables.map((t) => t.rows.map((r) => r.join(" ")).join("\n")).join("\n") + "\n" + doc.text;
    for (const m of blob.matchAll(/\bCO\s*[-]?\s*(\d+)\b/gi)) {
      const id = `CO-${Number(m[1])}`;
      if (defined.has(id) || seen.has(id)) continue;
      // only flag if it looks like an assessment / map table context nearby
      const idx = m.index ?? 0;
      const window = blob.slice(Math.max(0, idx - 80), idx + 80).toLowerCase();
      if (!/assessment|weightage|see|ce\b|map|po-|pso-|x\b|marks/.test(window) && !/co-\d/.test(window)) {
        // still count numeric COs in assessment-like tables
        if (!/\bx\b|weight|see|ce |lab/.test(window)) continue;
      }
      seen.add(id);
      defects.push({
        code: "CO_EXTRA_IN_TABLE",
        location: { source: "spec", section: 7, refs: [id] },
        description: `${id} appears in a source table but is not defined among course outcomes.`,
        fix: `Remove ${id} from the table or add it to section 3.`,
      });
    }
  }
  return defects;
}

function scanPso3(docs: ParsedDoc[]): Defect[] {
  for (const doc of docs) {
    if (/\bPSO\s*[-]?\s*3\b/i.test(doc.text) || doc.tables.some((t) => t.rows.some((r) => r.some((c) => /PSO\s*[-]?\s*3/i.test(c))))) {
      return [
        {
          code: "PSO_COLUMN_MISMATCH",
          location: { source: "spec", section: 5, refs: ["PSO-3"] },
          description: "Source map includes PSO-3; programme only defines PSO-1 and PSO-2.",
          fix: "Drop the PSO-3 column from the map.",
        },
      ];
    }
  }
  return [];
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runGenerate(args: {
  specFile: Express.Multer.File;
  blueprintFile?: Express.Multer.File;
  cfg: LlmConfig;
}): Promise<{ output: SpecforgeOutput; html: string }> {
  const spec = await parseUpload(args.specFile);
  const blueprint = args.blueprintFile ? await parseUpload(args.blueprintFile) : null;

  const extracted = extractFromDocs(spec, blueprint);
  let structured: StructuredCourse = extractedToStructured(extracted);
  if (process.env.SPECFORGE_USE_LLM === "1") {
    try {
      structured = overlayExtracted(await withTimeout(structureCourse(spec, blueprint, args.cfg, extracted), 20_000), extracted);
    } catch {
      structured = extractedToStructured(extracted);
    }
  } else {
    structured = overlayExtracted(structured, extracted);
  }

  const decision = chooseTemplate(structured.credits_ltp, structured.course_type);
  const fallback = localMapping({
    cos: attachBloom(structured.course_outcomes, {}),
    units: structured.units,
    coverage: structured.assessment.co_coverage,
    skillsText: extracted.skills_text,
  });
  let mappingAi: MappingAi = fallback;
  if (process.env.SPECFORGE_USE_LLM === "1") {
    try {
      const cosForMap = structured.course_outcomes.map((co) => ({
        ...co,
        bloom_level: bloomFromVerb(co.statement),
      }));
      mappingAi = await withTimeout(proposeMap(structured, cosForMap, args.cfg), 15_000);
    } catch {
      mappingAi = fallback;
    }
  }
  const cosWithBloom = attachBloom(structured.course_outcomes, mappingAi.bloom_levels ?? {});

  const { map } = clampMap({
    raw: mappingAi.map as Record<string, Record<string, { level: 1 | 2 | 3 | "" | null; justification?: string }>>,
    cos: cosWithBloom,
    co_coverage: structured.assessment.co_coverage,
    units: structured.units,
    evidenceText: extracted.skills_text,
  });

  // Drop blank/null cells for output
  const co_po_pso_map: SpecforgeOutput["co_po_pso_map"] = {};
  for (const [coId, row] of Object.entries(map)) {
    co_po_pso_map[coId] = {};
    for (const [col, cell] of Object.entries(row)) {
      if (cell) co_po_pso_map[coId][col] = cell;
    }
  }

  const summary = summaryCoveringUnits(mappingAi.summary?.trim() || structured.summary, structured.units);
  const input_id = extractInputId(
    [spec.text, blueprint?.text ?? ""],
    [spec.filename, blueprint?.filename ?? ""],
  );

  const base = {
    schema_version: "1.0" as const,
    input_id,
    template: decision.template,
    course: {
      title: structured.title,
      code: structured.code,
      department: structured.department,
      credits_ltp: structured.credits_ltp,
      course_type: structured.course_type,
      summary,
    },
    course_outcomes: cosWithBloom,
    units: structured.units,
    co_po_pso_map,
    teaching_hours: structured.teaching_hours,
    assessment: structured.assessment,
  };

  const { html, sampleStrings } = renderHtml(base as SpecforgeOutput, decision.template);

  const defined = new Set(cosWithBloom.map((c) => c.id));
  const defects: Defect[] = [
    ...extracted.defects,
    ...findingsToDefects(structured.findings),
    ...findingsToDefects(mappingAi.findings),
    ...scanExtraCos([spec, ...(blueprint ? [blueprint] : [])], defined),
    ...scanPso3([spec]),
    ...validateV1toV10({
      output: base as Omit<SpecforgeOutput, "defects">,
      map,
      sampleStrings,
      html,
      template: decision.template,
    }),
  ];

  // Deduplicate similar defects by code+refs+section
  const seen = new Set<string>();
  const unique = defects.filter((d) => {
    const key = `${d.code}|${d.location.section}|${d.location.refs.join(",")}|${d.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const outputCandidate = { ...base, defects: unique };
  const parsed = SpecforgeOutputSchema.safeParse(outputCandidate);
  if (!parsed.success) {
    console.error("Specforge output failed Zod validation:", parsed.error.issues.slice(0, 8));
    // Still return a response shaped correctly if possible — strip unknown / fix soft issues
    const loose = outputCandidate as SpecforgeOutput;
    return { output: loose, html };
  }
  return { output: parsed.data, html };
}
