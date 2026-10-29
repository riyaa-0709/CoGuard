import { readFileSync } from "node:fs";
import { extractFromDocs } from "../server/extract.js";
import { parseUpload } from "../server/parse.js";
import { renderHtml } from "../server/render.js";
import { chooseTemplate } from "../server/templateChoice.js";
import type { SpecforgeOutput } from "../server/schema.js";

function file(path: string, name: string): Express.Multer.File {
  return { buffer: readFileSync(path), originalname: name } as Express.Multer.File;
}

const spec = await parseUpload(file("sample-inputs/sample_course_spec.docx", "sample_course_spec.docx"));
const blueprint = await parseUpload(file("sample-inputs/sample_blueprint.doc", "sample_blueprint.doc"));
const ex = extractFromDocs(spec, blueprint);
const decision = chooseTemplate(ex.credits_ltp ?? "0:0:0", ex.course_type ?? "");

console.log("title", ex.title);
console.log("code", ex.code);
console.log("dept", ex.department);
console.log("type", ex.course_type);
console.log("credits", ex.credits_ltp);
console.log("template", decision.template, decision.signals);
console.log("COs", ex.course_outcomes.length, ex.course_outcomes.map((c) => c.id).join(", "));
console.log("units", ex.units.length, ex.units.map((u) => `${u.number}:${u.lab ? "lab" : "nolab"}`).join(", "));
console.log("hours", ex.teaching_hours);
console.log("interaction", ex.interaction_hours);
console.log("components", ex.assessment?.components);
console.log("coverage", ex.assessment?.co_coverage);
console.log("extract defects", ex.defects.map((d) => d.code));

const stub: SpecforgeOutput = {
  schema_version: "1.0",
  input_id: "SAMPLE",
  template: decision.template,
  course: {
    title: ex.title ?? "",
    code: ex.code ?? "",
    department: ex.department ?? "",
    credits_ltp: ex.credits_ltp ?? "0:0:0",
    course_type: ex.course_type ?? "",
    summary: ex.summary ?? "",
  },
  course_outcomes: ex.course_outcomes.map((c) => ({ ...c, bloom_level: 2 })),
  units: ex.units,
  co_po_pso_map: Object.fromEntries(ex.course_outcomes.map((c) => [c.id, { "PO-1": { level: 1 as const, justification: "Foundational coverage." } }])),
  teaching_hours: ex.teaching_hours ?? { lectures: 0, lab: 0, tests_exams: 0, total: 0 },
  assessment: ex.assessment ?? { components: [], co_coverage: {} },
  defects: ex.defects,
};

const { html, sampleStrings } = renderHtml(stub, decision.template);
const leftovers = sampleStrings.filter((s) => s && html.includes(s) && s !== stub.course.title && s !== stub.course.code && s !== stub.course.department);
console.log("sample strings", sampleStrings.length);
console.log("leftovers", leftovers.slice(0, 12));
console.log("has download button", html.includes("Download as PDF"));
const ids = [...html.matchAll(/CO-\d+/g)].map((m) => m[0]);
console.log("html COs", [...new Set(ids)]);
const i = html.indexOf("CO-6");
console.log("CO-6 context", i < 0 ? "none" : html.slice(Math.max(0, i - 160), i + 80).replace(/\s+/g, " "));
console.log("summary len", (ex.summary ?? "").length, "has CO-6", /CO-6/.test(ex.summary ?? ""));
