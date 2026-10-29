/** Rebuild outputs/specforge_output.json from sample files with no LLM call. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { clampMap } from "../server/clamp.js";
import { extractFromDocs } from "../server/extract.js";
import { attachBloom, localMapping, summaryCoveringUnits } from "../server/mapping.js";
import { extractInputId, parseUpload } from "../server/parse.js";
import { renderHtml } from "../server/render.js";
import { SpecforgeOutputSchema, type Defect, type SpecforgeOutput } from "../server/schema.js";
import { chooseTemplate } from "../server/templateChoice.js";
import { validateV1toV10 } from "../server/validate.js";

function file(path: string, name: string): Express.Multer.File {
  return { buffer: readFileSync(path), originalname: name } as Express.Multer.File;
}

const spec = await parseUpload(file("sample-inputs/sample_course_spec.docx", "sample_course_spec.docx"));
const blueprint = await parseUpload(file("sample-inputs/sample_blueprint.doc", "sample_blueprint.doc"));
const extracted = extractFromDocs(spec, blueprint);

const cos = attachBloom(extracted.course_outcomes, {});
const assessment = extracted.assessment ?? { components: [], co_coverage: {} };
const mappingAi = localMapping({
  cos,
  units: extracted.units,
  coverage: assessment.co_coverage,
  skillsText: extracted.skills_text,
});
const cosWithBloom = attachBloom(extracted.course_outcomes, mappingAi.bloom_levels ?? {});
const { map } = clampMap({
  raw: mappingAi.map,
  cos: cosWithBloom,
  co_coverage: assessment.co_coverage,
  units: extracted.units,
  evidenceText: extracted.skills_text,
});

const co_po_pso_map: SpecforgeOutput["co_po_pso_map"] = {};
for (const [coId, row] of Object.entries(map)) {
  co_po_pso_map[coId] = {};
  for (const [col, cell] of Object.entries(row)) {
    if (cell) co_po_pso_map[coId][col] = cell;
  }
}

const decision = chooseTemplate(extracted.credits_ltp ?? "0:0:0", extracted.course_type ?? "");
const summary = summaryCoveringUnits(extracted.summary ?? "", extracted.units);
const teaching_hours = extracted.teaching_hours ?? { lectures: 0, lab: 0, tests_exams: 0, total: 0 };

const base = {
  schema_version: "1.0" as const,
  input_id: extractInputId([spec.text, blueprint.text], [spec.filename, blueprint.filename]),
  template: decision.template,
  course: {
    title: extracted.title ?? "",
    code: extracted.code ?? "",
    department: extracted.department ?? "",
    credits_ltp: extracted.credits_ltp ?? "0:0:0",
    course_type: extracted.course_type ?? "",
    summary,
  },
  course_outcomes: cosWithBloom,
  units: extracted.units,
  co_po_pso_map,
  teaching_hours,
  assessment,
};

const { html, sampleStrings } = renderHtml(base as SpecforgeOutput, decision.template);
const defined = new Set(cosWithBloom.map((c) => c.id));
const defects: Defect[] = [
  ...extracted.defects,
  ...(() => {
    const extra: Defect[] = [];
    const blob = spec.tables.map((t) => t.rows.map((r) => r.join(" ")).join("\n")).join("\n") + "\n" + spec.text;
    const seen = new Set<string>();
    for (const m of blob.matchAll(/\bCO\s*[-]?\s*(\d+)\b/gi)) {
      const id = `CO-${Number(m[1])}`;
      if (defined.has(id) || seen.has(id)) continue;
      const idx = m.index ?? 0;
      const window = blob.slice(Math.max(0, idx - 80), idx + 80).toLowerCase();
      if (!/assessment|weightage|see|ce\b|map|po-|pso-|x\b|marks/.test(window) && !/\bx\b|weight|see|ce |lab/.test(window)) continue;
      seen.add(id);
      extra.push({
        code: "CO_EXTRA_IN_TABLE",
        location: { source: "spec", section: 7, refs: [id] },
        description: `${id} appears in a source table but is not defined among course outcomes.`,
        fix: `Remove ${id} from the table or add it to section 3.`,
      });
    }
    return extra;
  })(),
  ...( /\bPSO\s*[-]?\s*3\b/i.test(spec.text) || spec.tables.some((t) => t.rows.some((r) => r.some((c) => /PSO\s*[-]?\s*3/i.test(c))))
    ? [
        {
          code: "PSO_COLUMN_MISMATCH" as const,
          location: { source: "spec" as const, section: 5, refs: ["PSO-3"] },
          description: "Source map includes PSO-3; programme only defines PSO-1 and PSO-2.",
          fix: "Drop the PSO-3 column from the map.",
        },
      ]
    : []),
  ...validateV1toV10({
    output: base,
    map,
    sampleStrings,
    html,
    template: decision.template,
  }),
];

const seen = new Set<string>();
const unique = defects.filter((d) => {
  const key = `${d.code}|${d.location.section}|${d.location.refs.join(",")}|${d.description}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const parsed = SpecforgeOutputSchema.safeParse({ ...base, defects: unique });
if (!parsed.success) {
  console.error(parsed.error.issues.slice(0, 12));
  throw new Error("Zod failed");
}

mkdirSync("outputs", { recursive: true });
writeFileSync("outputs/specforge_output.json", JSON.stringify(parsed.data, null, 2));
writeFileSync("outputs/spec.html", html);
console.log(
  JSON.stringify(
    {
      input_id: parsed.data.input_id,
      template: parsed.data.template,
      credits: parsed.data.course.credits_ltp,
      cos: parsed.data.course_outcomes.map((c) => `${c.id}:L${c.bloom_level}`),
      units: parsed.data.units.map((u) => `${u.number}:${u.title}:${u.lab ? "lab" : "nolab"}`),
      hours: parsed.data.teaching_hours,
      components: parsed.data.assessment.components,
      coverage: parsed.data.assessment.co_coverage,
      defects: parsed.data.defects.map((d) => `${d.code}@${d.location.source}:${d.location.section}`),
      mapKeys: Object.fromEntries(Object.entries(parsed.data.co_po_pso_map).map(([k, v]) => [k, Object.keys(v)])),
    },
    null,
    2,
  ),
);
