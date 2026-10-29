import type { ParsedDoc } from "./parse.js";
import type { Defect, StructuredCourse } from "./schema.js";

export type Extracted = {
  title?: string;
  code?: string;
  department?: string;
  course_type?: string;
  credits_ltp?: string;
  summary?: string;
  interaction_hours?: number;
  course_outcomes: { id: string; statement: string }[];
  units: { number: number; title: string; lab: string | null }[];
  teaching_hours?: { lectures: number; lab: number; tests_exams: number; total: number };
  assessment?: StructuredCourse["assessment"];
  defects: Defect[];
};

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function coId(n: string): string {
  return `CO-${Number(n)}`;
}

function labelValue(tables: ParsedDoc["tables"], label: RegExp): string | undefined {
  for (const t of tables) {
    for (const row of t.rows) {
      if (row.length < 2) continue;
      if (label.test(norm(row[0]))) {
        const v = norm(row[1]);
        if (v) return v;
      }
    }
  }
  return undefined;
}

function parseCos(text: string): { id: string; statement: string }[] {
  const out: { id: string; statement: string }[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\n)\s*CO\s*[-]?\s*(\d+)\s*[.:)\t]*\s*([^\n]{8,})/gi;
  for (const m of text.matchAll(re)) {
    const id = coId(m[1]);
    const statement = norm(m[2]).replace(/^[.:)\s]+/, "");
    if (seen.has(id)) continue;
    if (/^description\b/i.test(statement) || /^remarks\b/i.test(statement)) continue;
    seen.add(id);
    out.push({ id, statement });
  }
  return out;
}

function parseLabs(specText: string): Map<number, string> {
  const labs = new Map<number, string>();
  const parts = specText.split(/(?=Unit\s+\d+)/i);
  for (const part of parts) {
    const head = part.match(/^Unit\s+(\d+)/i);
    if (!head) continue;
    const lab = part.match(/Lab\s+Exercises?\s*:?\s*([\s\S]*?)(?=Unit\s+\d+|Course\s+Map|Course\s+Teaching|Course\s+Assessment|$)/i);
    if (!lab) continue;
    const text = norm(lab[1]);
    if (text.length > 3) labs.set(Number(head[1]), text);
  }
  return labs;
}

function parseUnits(blueprint: ParsedDoc | null, spec: ParsedDoc): Extracted["units"] {
  const labs = parseLabs(spec.text);
  const units: Extracted["units"] = [];

  const source = blueprint ?? spec;
  for (const t of source.tables) {
    for (const row of t.rows) {
      if (!row.length) continue;
      const n = norm(row[0]).match(/^(\d{1,2})$/);
      if (!n) continue;
      const title = norm(row[1] ?? "");
      if (title.length < 8) continue;
      if (/^total\b/i.test(title)) continue;
      const num = Number(n[1]);
      if (units.some((u) => u.number === num)) continue;
      units.push({ number: num, title, lab: labs.get(num) ?? null });
    }
    if (units.length >= 2) break;
  }

  if (!units.length) {
    const re = /Unit\s+(\d+)\s*(?:\(([^)]+)\)|[:.\-–])\s*([^\n]+)/gi;
    for (const m of spec.text.matchAll(re)) {
      const num = Number(m[1]);
      const title = norm(m[2] || m[3]);
      if (!title || units.some((u) => u.number === num)) continue;
      units.push({ number: num, title, lab: labs.get(num) ?? null });
    }
  } else {
    for (const u of units) {
      if (!u.lab) u.lab = labs.get(u.number) ?? null;
    }
  }
  return units.sort((a, b) => a.number - b.number);
}

function lastNumber(cells: string[]): number | null {
  for (let i = cells.length - 1; i >= 0; i--) {
    const m = norm(cells[i]).match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]);
  }
  return null;
}

function parseHours(spec: ParsedDoc): { hours?: Extracted["teaching_hours"]; interaction?: number } {
  let lectures: number | null = null;
  let lab: number | null = null;
  let tests: number | null = null;
  let total: number | null = null;
  let interaction: number | undefined;

  for (const t of spec.tables) {
    for (const row of t.rows) {
      const label = norm(row[0] ?? "");
      const low = label.toLowerCase();
      const n = lastNumber(row);
      if (/total hours of interaction/i.test(low) && n != null) interaction = n;
      if (/face to face/i.test(low) && n != null) lectures = n;
      if ((/^practical work$/i.test(low) || /^practicals?$/i.test(low)) && n != null) lab = n;
      if (/computer laboratory/i.test(low) && n != null && (lab == null || lab === 0)) lab = n;
      if (/mid terms|term tests|laboratory examination\/written|written examination/i.test(label) && n != null) tests = n;
      if (/^total duration/i.test(low) && n != null) total = n;
    }
  }

  if (lectures == null && lab == null && tests == null && total == null) return { interaction };
  return {
    interaction,
    hours: {
      lectures: lectures ?? 0,
      lab: lab ?? 0,
      tests_exams: tests ?? 0,
      total: total ?? (lectures ?? 0) + (lab ?? 0) + (tests ?? 0),
    },
  };
}

function parseAssessment(spec: ParsedDoc, coIds: string[]): Extracted["assessment"] | undefined {
  let table: string[][] | null = null;
  for (const t of spec.tables) {
    const blob = t.rows.map((r) => r.join(" ")).join("\n");
    if (/weightage/i.test(blob) && /CO\s*[-]?\s*\d/i.test(blob)) {
      table = t.rows;
      break;
    }
  }
  if (!table) return undefined;

  const blob = table.map((r) => r.join(" | ")).join("\n");
  const components: { name: string; weight_percent: number }[] = [];
  for (const m of blob.matchAll(/([A-Za-z][A-Za-z /]{0,24}?)\s*\(?\s*Weightage:\s*(\d+(?:\.\d+)?)\s*%/gi)) {
    const name = norm(m[1]).replace(/[:(]+$/, "").trim();
    if (!name || components.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
    components.push({ name, weight_percent: Number(m[2]) });
  }

  let headers: string[] = [];
  for (const row of table) {
    const cells = row.map(norm).filter(Boolean);
    const hits = cells.filter((c) => /test|assign|lab|written|see|exam/i.test(c) && !/weightage|marks|course outcome|focus/i.test(c));
    if (hits.length >= 2) headers = hits;
  }

  const allowed = new Set(coIds);
  const co_coverage: Record<string, string[]> = {};
  for (const row of table) {
    const idm = norm(row[0] ?? "").match(/^CO\s*[-]?\s*(\d+)$/i);
    if (!idm) continue;
    const id = coId(idm[1]);
    if (!allowed.has(id)) continue;
    const marks: string[] = [];
    for (let i = 1; i < row.length; i++) {
      if (!/^x$/i.test(norm(row[i]))) continue;
      const header = headers[i - 1];
      if (header) marks.push(header);
    }
    co_coverage[id] = marks;
  }

  if (!components.length && !Object.keys(co_coverage).length) return undefined;
  return { components, co_coverage };
}

function hoursDefect(interaction: number | undefined, hours: Extracted["teaching_hours"]): Defect[] {
  if (!hours) return [];
  const defects: Defect[] = [];
  const sum = hours.lectures + hours.lab + hours.tests_exams;
  if (Math.abs(sum - hours.total) > 0.01) {
    defects.push({
      code: "HOURS_INCONSISTENT",
      location: { source: "spec", section: 6, refs: [] },
      description: `Teaching-hour rows sum to ${sum} but the stated total is ${hours.total}.`,
      fix: "Use the stated section-6 total and record the mismatch.",
    });
  }
  if (interaction != null && Math.abs(interaction - hours.total) > 0.01) {
    defects.push({
      code: "HOURS_INCONSISTENT",
      location: { source: "spec", section: 2, refs: [] },
      description: `Total hours of interaction (${interaction}) do not match the teaching-hours total (${hours.total}).`,
      fix: "Keep the teaching-hours table total and flag the section 2 figure.",
    });
  }
  return defects;
}

export function extractFromDocs(spec: ParsedDoc, blueprint: ParsedDoc | null): Extracted {
  const defects: Defect[] = [];
  const title = labelValue(spec.tables, /^course title$/i);
  const code = labelValue(spec.tables, /^course code$/i);
  const department = labelValue(spec.tables, /^department$/i);
  const course_type = labelValue(spec.tables, /^course type$/i);
  const credits =
    labelValue(spec.tables, /credit structure/i)?.match(/\d+:\d+:\d+/)?.[0] ??
    spec.text.match(/\b(\d+:\d+:\d+)\b/)?.[1];

  const summary = spec.text.match(/Course Summary\s+([\s\S]*?)(?=Course Size and Credits|Course Outcomes)/i)?.[1];

  const bpCos = blueprint ? parseCos(blueprint.text) : [];
  const specCos = parseCos(spec.text);
  const course_outcomes = bpCos.length ? bpCos : specCos;
  if (blueprint && !bpCos.length) {
    defects.push({
      code: "OTHER",
      location: { source: "blueprint", section: 3, refs: [] },
      description: "Blueprint was supplied but no course outcomes could be read from it; outcomes were taken from the spec.",
      fix: "Read course outcomes from the blueprint table.",
    });
  }

  const units = parseUnits(blueprint, spec);
  const { hours, interaction } = parseHours(spec);
  defects.push(...hoursDefect(interaction, hours));

  const assessment = parseAssessment(spec, course_outcomes.map((c) => c.id));

  // Broken CO labels such as "CO- 4" in the source spec.
  if (/CO-\s+\d/i.test(spec.text)) {
    const refs = [...spec.text.matchAll(/CO-\s+(\d+)/gi)].map((m) => coId(m[1]));
    defects.push({
      code: "TYPO_OR_FORMAT",
      location: { source: "spec", section: 3, refs: [...new Set(refs)] },
      description: "A course-outcome label has a stray space before the number.",
      fix: "Normalise the label to CO-n.",
    });
  }

  return {
    title,
    code,
    department,
    course_type,
    credits_ltp: credits,
    summary: summary ? norm(summary) : undefined,
    interaction_hours: interaction,
    course_outcomes,
    units,
    teaching_hours: hours,
    assessment,
    defects,
  };
}

/** Table reads win over the model for fields the files actually contain. */
export function overlayExtracted(ai: StructuredCourse, extracted: Extracted): StructuredCourse {
  return {
    ...ai,
    title: extracted.title || ai.title,
    code: extracted.code || ai.code,
    department: extracted.department || ai.department,
    course_type: extracted.course_type || ai.course_type,
    credits_ltp: extracted.credits_ltp || ai.credits_ltp,
    summary: ai.summary || extracted.summary || "",
    course_outcomes: extracted.course_outcomes.length ? extracted.course_outcomes : ai.course_outcomes,
    units: extracted.units.length ? extracted.units : ai.units,
    teaching_hours: extracted.teaching_hours ?? ai.teaching_hours,
    assessment: extracted.assessment ?? ai.assessment,
    findings: ai.findings,
  };
}
