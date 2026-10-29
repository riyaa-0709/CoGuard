import type { LlmConfig } from "./llm.js";
import { generateJson } from "./llm.js";
import type { ParsedDoc } from "./parse.js";
import { StructuredCourseSchema, type StructuredCourse } from "./schema.js";

function chunk(s: string, max = 12000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…[truncated]…\n" + s.slice(-Math.min(4000, s.length - max));
}

function tablesBlock(doc: ParsedDoc): string {
  return doc.tables
    .map((t, i) => `Table ${i + 1}:\n` + t.rows.map((r) => r.join(" | ")).join("\n"))
    .join("\n\n");
}

export async function structureCourse(spec: ParsedDoc, blueprint: ParsedDoc | null, cfg: LlmConfig): Promise<StructuredCourse> {
  const bpNote = blueprint
    ? `A blueprint is supplied. Course outcomes (id + statement) and units (number, title, lab) MUST come from the BLUEPRINT. All other fields come from the SPEC.`
    : `No blueprint supplied. Take course outcomes and units from the SPEC. Note "no blueprint supplied" only in findings if relevant.`;

  const prompt = `You extract a university course specification into JSON.

${bpNote}

Rules:
- credits_ltp must be "L:T:P" digits like "3:0:1".
- course_outcomes ids must be "CO-1", "CO-2", … (normalise CO1 / "CO- 4" → CO-4).
- units: number, short title, and lab text or null.
- teaching_hours: map Face-to-Face Lectures → lectures, Practical/Computer Laboratory total → lab, Mid Terms/Laboratory Examination/Written Examination → tests_exams, and the stated Total Duration → total. Use numbers from the teaching-hours tables.
- assessment.components: top-level weight groups (e.g. CE, SEE, Lab) with weight_percent numbers that appear in the assessment table headers. Prefer CE + SEE (+ Lab if separate) covering 100.
- assessment.co_coverage: each CO id → list of component names marked X for that CO (e.g. "Tests", "Assignments", "Lab CE", "Written exam", "LSEE").
- findings: only real issues you see (typos like broken CO labels, summary that clearly misses units). Use codes TYPO_OR_FORMAT, SUMMARY_SYLLABUS_MISMATCH, LABEL_OR_TITLE_MISMATCH, or OTHER.

=== SPEC TEXT ===
${chunk(spec.text)}

=== SPEC TABLES ===
${chunk(tablesBlock(spec), 8000)}

${
  blueprint
    ? `=== BLUEPRINT TEXT ===
${chunk(blueprint.text)}

=== BLUEPRINT TABLES ===
${chunk(tablesBlock(blueprint), 6000)}`
    : ""
}

Return JSON matching:
{
  "title","code","department","credits_ltp","course_type","summary",
  "course_outcomes":[{"id","statement"}],
  "units":[{"number","title","lab"}],
  "teaching_hours":{"lectures","lab","tests_exams","total"},
  "assessment":{"components":[{"name","weight_percent"}],"co_coverage":{"CO-1":["…"]}},
  "findings":[{"code","description","location_section","refs","source"}]
}`;

  return generateJson(prompt, StructuredCourseSchema, cfg);
}
