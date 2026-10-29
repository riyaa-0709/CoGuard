import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bloomFromVerb } from "./bloom.js";
import type { ParsedDoc } from "./parse.js";
import type { Defect, StructuredCourse } from "./schema.js";

const REFERENCE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "config/reference_names.json"), "utf8"),
) as { publishers: string[]; tlds: string[] };

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
  skills_text?: string;
  unit_topics: Record<number, string>;
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

function lastNumber(cells: string[]): number | null {
  for (let i = cells.length - 1; i >= 0; i--) {
    const m = norm(cells[i]).match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]);
  }
  return null;
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

/** Short heading: text in parentheses, else the clause before the first colon. */
function shortUnitTitle(raw: string, parenHint?: string): string {
  let t = norm(raw);
  t = t.replace(/\s+Lab\s+Exercises?\b[\s\S]*$/i, "");
  t = t.replace(/\s+\d+\s*$/, "");
  const colon = t.match(/^(.{3,80}?)\s*:\s+\S/);
  const clause = colon ? colon[1].trim() : t.split(/[.;]/)[0].slice(0, 80).trim();
  if (parenHint) {
    const p = parenHint.trim();
    if (p.length >= 3 && (clause.toLowerCase() === p.toLowerCase() || t.toLowerCase().includes(p.toLowerCase()))) {
      return p;
    }
  }
  return clause;
}

function specParenTitles(specText: string): Map<number, string> {
  const titles = new Map<number, string>();
  for (const m of specText.matchAll(/Unit\s+(\d+)\s*\(([^)]+)\)/gi)) {
    const title = norm(m[2]);
    if (title) titles.set(Number(m[1]), title);
  }
  return titles;
}

function parseLabs(specText: string): Map<number, string> {
  const labs = new Map<number, string>();
  const parts = specText.split(/(?=Unit\s+\d+)/i);
  for (const part of parts) {
    const head = part.match(/^Unit\s+(\d+)/i);
    if (!head) continue;
    const lab = part.match(/Lab\s+Exercises?\s*:?\s*([\s\S]+)/i);
    if (!lab) continue;
    let text = norm(lab[1]).replace(/\s*Course\s+Map[\s\S]*$/i, "").trim();
    if (text.length < 4) continue;
    if (/^on\b/i.test(text)) text = `Lab exercises ${text}`;
    labs.set(Number(head[1]), text);
  }
  return labs;
}

function parseUnits(blueprint: ParsedDoc | null, spec: ParsedDoc): Extracted["units"] {
  const labs = parseLabs(spec.text);
  const paren = specParenTitles(spec.text);
  const units: Extracted["units"] = [];
  const source = blueprint ?? spec;

  for (const t of source.tables) {
    for (const row of t.rows) {
      if (!row.length) continue;
      const n = norm(row[0]).match(/^(\d{1,2})$/);
      if (!n) continue;
      const rawTitle = norm(row[1] ?? "");
      if (rawTitle.length < 8) continue;
      if (/^total\b/i.test(rawTitle)) continue;
      if (/^up to\b/i.test(rawTitle)) continue;
      const num = Number(n[1]);
      if (units.some((u) => u.number === num)) continue;
      const title = shortUnitTitle(rawTitle, paren.get(num));
      if (!title) continue;
      units.push({ number: num, title, lab: labs.get(num) ?? null });
    }
  }

  if (!units.length) {
    for (const [num, title] of paren) {
      units.push({ number: num, title, lab: labs.get(num) ?? null });
    }
  } else {
    for (const u of units) {
      if (!u.lab) u.lab = labs.get(u.number) ?? null;
    }
  }
  return units.sort((a, b) => a.number - b.number);
}

// Each unit's topic text (after "Title:" in the blueprint, or "Unit n (Title):" in the spec).
function parseUnitTopics(blueprint: ParsedDoc | null, spec: ParsedDoc): Record<number, string> {
  const topics: Record<number, string> = {};
  for (const t of blueprint?.tables ?? []) {
    for (const row of t.rows) {
      const n = norm(row[0] ?? "").match(/^(\d{1,2})$/);
      const cell = norm(row[1] ?? "");
      const colon = cell.indexOf(":");
      if (n && colon > 0 && !topics[Number(n[1])]) topics[Number(n[1])] = cell.slice(colon + 1).trim();
    }
  }
  if (!Object.keys(topics).length) {
    for (const m of spec.text.matchAll(/Unit\s+(\d+)\s*\([^)]*\)\s*:\s*([\s\S]*?)(?=Lab Exercises|Unit\s+\d+\s*\(|Course Map|$)/gi)) {
      topics[Number(m[1])] = norm(m[2]);
    }
  }
  return topics;
}

function parseHours(spec: ParsedDoc): {
  hours?: Extracted["teaching_hours"];
  interaction?: number;
  tableTotal?: number;
} {
  let lectures: number | null = null;
  let lab: number | null = null;
  let tests: number | null = null;
  let tableTotal: number | null = null;
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
      if (/mid terms|term tests|laboratory examination\/written|written examination/i.test(label) && n != null) {
        tests = n;
      }
      if (/^total duration/i.test(low) && n != null) tableTotal = n;
    }
  }

  if (lectures == null && lab == null && tests == null && tableTotal == null) return { interaction, tableTotal: tableTotal ?? undefined };
  return {
    interaction,
    tableTotal: tableTotal ?? undefined,
    hours: {
      lectures: lectures ?? 0,
      lab: lab ?? 0,
      tests_exams: tests ?? 0,
      total: tableTotal ?? (lectures ?? 0) + (lab ?? 0) + (tests ?? 0),
    },
  };
}

function parentComponent(sub: string, components: { name: string }[]): string | null {
  const s = sub.toLowerCase();
  const find = (re: RegExp) => components.find((c) => re.test(c.name.toLowerCase()))?.name ?? null;
  if (/lsee|lab exam|lab see/.test(s)) return find(/^lab$/) ?? find(/lab/);
  if (/written/.test(s) && !/lab/.test(s)) return find(/^see$/) ?? find(/see|end exam/);
  if (/lab ce/.test(s)) return find(/^ce$/) ?? find(/continuous/);
  if (/test|assign/.test(s)) return find(/^ce$/) ?? find(/continuous/);
  if (/^lab$/.test(s)) return find(/^lab$/);
  return null;
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
      if (!header) continue;
      marks.push(header);
      const parent = parentComponent(header, components);
      if (parent) marks.push(parent);
    }
    co_coverage[id] = [...new Set(marks)];
  }

  if (!components.length && !Object.keys(co_coverage).length) return undefined;
  return { components, co_coverage };
}

function parseSkillsText(spec: ParsedDoc): string {
  const bits: string[] = [];
  for (const t of spec.tables) {
    if (!t.rows.some((r) => /curriculum and capabilities/i.test(r.join(" ")))) continue;
    for (const row of t.rows) {
      const name = norm(row[1] ?? "");
      const how = norm(row[2] ?? "");
      if (!name || !how || /^--+$/.test(how) || /capabilities skills/i.test(name)) continue;
      bits.push(`${name}: ${how}`);
    }
  }
  return bits.join("; ");
}

function hoursDefect(
  interaction: number | undefined,
  tableTotal: number | undefined,
  hours: Extracted["teaching_hours"] | undefined,
): Defect[] {
  if (!hours) return [];
  const defects: Defect[] = [];
  const sum = hours.lectures + hours.lab + hours.tests_exams;
  if (tableTotal != null && interaction != null && Math.abs(tableTotal - interaction) > 0.01) {
    defects.push({
      code: "HOURS_INCONSISTENT",
      location: { source: "spec", section: 2, refs: [] },
      description: `Total hours of interaction (${interaction}) do not match the teaching-and-learning table total (${tableTotal}; ${hours.lectures} lectures + ${hours.lab} lab + ${hours.tests_exams} tests/exams = ${sum}).`,
      fix: "Keep the teaching-hours table total and flag the section 2 figure.",
    });
    return defects;
  }
  if (Math.abs(sum - hours.total) > 0.01 && Math.abs(hours.lectures + hours.lab - hours.total) > 0.01) {
    defects.push({
      code: "HOURS_INCONSISTENT",
      location: { source: "spec", section: 6, refs: [] },
      description: `Teaching-hour rows sum to ${sum} but the stated total is ${hours.total}.`,
      fix: "Correct component hours or the total so they match.",
    });
  }
  return defects;
}

function typoDefect(spec: ParsedDoc): Defect[] {
  const html = spec.html ?? "";
  const text = spec.text ?? "";
  const defects: Defect[] = [];
  const refs = new Set<string>();
  for (const m of html.matchAll(/CO-<\/[^>]+>\s*(\d+)/gi)) refs.add(coId(m[1]));
  for (const m of text.matchAll(/CO-\s+(\d+)/gi)) refs.add(coId(m[1]));
  if (refs.size) {
    defects.push({
      code: "TYPO_OR_FORMAT",
      location: { source: "spec", section: 3, refs: [...refs] },
      description: `${[...refs].join(", ")} label is split across tags or spaces (CO- then the number), so the identifier is malformed.`,
      fix: "Normalise the label to CO-n.",
    });
  }

  defects.push(...badUrlDefects(text), ...publisherSpellingDefects(text));
  return defects;
}

// URLs whose last label is not a known domain ending (e.g. ".rg" for ".org").
function badUrlDefects(text: string): Defect[] {
  const defects: Defect[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)([a-z0-9.-]+\.[a-z]+)(?![a-z0-9.-])/gi)) {
    const host = m[1].toLowerCase().replace(/^www\./, "");
    const tld = host.split(".").pop() ?? "";
    if (REFERENCE.tlds.includes(tld) || seen.has(host)) continue;
    seen.add(host);
    defects.push({
      code: "TYPO_OR_FORMAT",
      location: { source: "spec", section: 9, refs: [] },
      description: `A course-resource URL uses the host ${host}, whose ending ".${tld}" is not a valid domain.`,
      fix: "Correct the URL's domain ending.",
    });
  }
  return defects;
}

// Publisher names one edit away from a known publisher (a swapped pair of letters counts as one edit).
function publisherSpellingDefects(text: string): Defect[] {
  const defects: Defect[] = [];
  const words = new Set(text.match(/[A-Z][A-Za-z'\u2018\u2019-]{3,}/g) ?? []);
  for (const publisher of REFERENCE.publishers) {
    const target = normaliseName(publisher.split(/\s+/)[0]);
    if (target.length < 5) continue;
    for (const word of words) {
      const w = normaliseName(word);
      if (w === target || Math.abs(w.length - target.length) > 1) continue;
      if (editDistance(w, target) > 1) continue;
      defects.push({
        code: "TYPO_OR_FORMAT",
        location: { source: "spec", section: 9, refs: [] },
        description: `Recommended reading spells the publisher as ${word}.`,
        fix: `Correct the publisher name to ${publisher.split(/\s+/)[0]}.`,
      });
    }
  }
  return defects;
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

// Optimal string alignment distance: a swapped pair of letters counts as one edit.
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function labelMismatchDefects(spec: ParsedDoc, title?: string): Defect[] {
  const defects: Defect[] = [];
  if (/\bAchieving Cos\b/.test(spec.text)) {
    defects.push({
      code: "LABEL_OR_TITLE_MISMATCH",
      location: { source: "spec", section: 8, refs: [] },
      description: "Section heading is written as 'Achieving Cos' rather than 'Achieving COs'.",
      fix: "Rename the heading to Achieving COs to match the template.",
    });
  }
  return defects;
}

function extraSectionDefects(spec: ParsedDoc): Defect[] {
  if (!/Course Organization/i.test(spec.text)) return [];
  return [
    {
      code: "SECTION_NOT_IN_TEMPLATE",
      location: { source: "spec", section: 10, refs: [] },
      description: "The spec includes a Course Organization section that is not one of the numbered template body sections (1–9).",
      fix: "Keep Course Organization out of the filled template body; record it as dropped content.",
    },
  ];
}

function summaryMismatchDefects(summary: string | undefined, units: Extracted["units"]): Defect[] {
  if (!summary || !units.length) return [];
  const low = summary.toLowerCase();
  const missing = units.filter((u) => u.title.length >= 4 && !low.includes(u.title.toLowerCase()));
  if (!missing.length) return [];
  return [
    {
      code: "SUMMARY_SYLLABUS_MISMATCH",
      location: { source: "spec", section: 1, refs: missing.map((u) => `Unit-${u.number}`) },
      description: `The source course summary does not name syllabus unit(s) ${missing.map((u) => `${u.number} (${u.title})`).join("; ")}.`,
      fix: "Rewrite the output summary so every unit title appears.",
    },
  ];
}

function parseSourceMap(spec: ParsedDoc): { coId: string; cells: { col: string; raw: string }[] }[] {
  const out: { coId: string; cells: { col: string; raw: string }[] }[] = [];
  for (const t of spec.tables) {
    const blob = t.rows.map((r) => r.join(" ")).join(" ");
    if (!/PO-1/i.test(blob) || !/PSO/i.test(blob)) continue;
    let cols: string[] = [];
    for (const row of t.rows) {
      const cells = row.map(norm);
      const poish = cells.filter((c) => /^(PO|PSO)\s*[-]?\s*\d+$/i.test(c));
      if (poish.length >= 8) {
        cols = poish.map((c) => {
          const m = c.match(/^(PO|PSO)\s*[-]?\s*(\d+)$/i);
          return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : c;
        });
        continue;
      }
      const idm = cells[0]?.match(/^CO\s*[-]?\s*(\d+)$/i);
      if (!idm || !cols.length) continue;
      const values = cells.slice(1);
      out.push({
        coId: coId(idm[1]),
        cells: cols.map((col, i) => ({ col, raw: values[i] ?? "" })),
      });
    }
  }
  return out;
}

function isPracticalName(name: string): boolean {
  return /lab|practical|assignment|programming|project/i.test(name);
}

// Strongest PO-3 (design) link a Bloom level supports: understanding-level outcomes cannot design.
function designCeiling(bloom: number): 1 | 2 | 3 {
  return bloom <= 2 ? 1 : bloom <= 4 ? 2 : 3;
}

// Words in the syllabus or assessment that count as evidence for PO-6 to PO-10.
const SOFT_PO_EVIDENCE: Record<string, RegExp> = {
  "PO-6": /societ|environment|sustainab|health|safety|legal|culture/i,
  "PO-7": /ethic|professional integrity|human values|diversity|inclusion/i,
  "PO-8": /team|group work|collaborat|peer|pair/i,
  "PO-9": /communicat|presentation|report|documentation/i,
  "PO-10": /project management|financ|econom|cost|budget/i,
};

// One defect per source-map cell: the first rule it breaks.
function sourceMapRuleDefects(
  spec: ParsedDoc,
  coverage: Record<string, string[]>,
  bloomByCo: Map<string, number>,
  contentsText: string,
): Defect[] {
  const defects: Defect[] = [];
  for (const row of parseSourceMap(spec)) {
    const comps = coverage[row.coId] ?? [];
    const practical = comps.some(isPracticalName);
    const toolUse = comps.some((c) => /lab|practical|programming/i.test(c));
    const evidence = `${contentsText} ${comps.join(" ")}`;
    const bloom = bloomByCo.get(row.coId);
    for (const cell of row.cells) {
      const raw = cell.raw.trim();
      if (!raw) continue;
      const refs = [row.coId, cell.col];
      const add = (code: Defect["code"], description: string, fix: string) =>
        defects.push({ code, location: { source: "spec", section: 5, refs }, description, fix });
      if (!/^[123]$/.test(raw)) {
        if (/very strong|strong contribution|moderate/i.test(raw)) continue;
        add("MAPPING_UNSUPPORTED", `${row.coId}/${cell.col} has mapping value "${raw}" (only 1, 2, 3 or blank are allowed).`, `Blank ${row.coId}/${cell.col} or set it to 1, 2 or 3.`);
        continue;
      }
      if (!/^PO-\d+$/.test(cell.col)) continue;
      const level = Number(raw) as 1 | 2 | 3;
      const ceiling = bloom == null || cell.col === "PO-1" ? 3 : cell.col === "PO-3" ? designCeiling(bloom) : bloom <= 1 ? 1 : bloom <= 2 ? 2 : 3;
      if (level > ceiling) {
        add("MAPPING_BLOOM_MISMATCH", `${row.coId} is Bloom L${bloom} but the source map sets ${cell.col}=${level}; the most that level supports is ${ceiling}.`, `Lower ${row.coId}/${cell.col} to ${ceiling} or less.`);
      } else if (SOFT_PO_EVIDENCE[cell.col] && !SOFT_PO_EVIDENCE[cell.col].test(evidence)) {
        add("MAPPING_UNSUPPORTED", `Source map sets ${row.coId}→${cell.col}=${level}, but the syllabus and assessment show no evidence for ${cell.col}.`, `Blank ${row.coId}/${cell.col}.`);
      } else if (cell.col === "PO-5" && level >= 2 && !toolUse) {
        add("MAPPING_UNSUPPORTED", `Source map sets ${row.coId}→PO-5=${level}, but ${row.coId} is not assessed in a lab or programming component, so there is no real tool use.`, `Lower or blank ${row.coId}/PO-5.`);
      } else if ((cell.col === "PO-3" || cell.col === "PO-5") && level >= 2 && !practical) {
        add("MAPPING_UNSUPPORTED", `Source map sets ${row.coId}→${cell.col}=${level} but ${row.coId} is not assessed in a practical or assignment.`, `Blank ${cell.col} or add practical/assignment coverage for ${row.coId}.`);
      }
    }
  }
  return defects;
}

// A unit's lab line that names a different unit title (e.g. a shortened or older title).
function labLabelDefects(units: Extracted["units"]): Defect[] {
  const defects: Defect[] = [];
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  for (const u of units) {
    const named = u.lab?.match(/^Lab exercises on\s+(.+?)\.?$/i)?.[1];
    if (!named) continue;
    const t = words(u.title);
    const n = words(named);
    if (t.length < 2 || n.join(" ") === t.join(" ")) continue;
    if (n[0] !== t[0] || n[1] !== t[1]) continue;
    defects.push({
      code: "LABEL_OR_TITLE_MISMATCH",
      location: { source: "spec", section: 4, refs: [`Unit-${u.number}`] },
      description: `Unit ${u.number}'s lab line names "${named}", which does not match the unit title "${u.title}".`,
      fix: `Rename the lab line to match the unit title "${u.title}".`,
    });
  }
  return defects;
}

function labAssessmentDefect(assessment: Extracted["assessment"] | undefined, defined: string[]): Defect[] {
  if (!assessment) return [];
  const hasLabComponent = assessment.components.some((c) => /^lab$/i.test(c.name) || /lab/i.test(c.name));
  if (!hasLabComponent) return [];
  const labbed = defined.filter((id) => (assessment.co_coverage[id] ?? []).some((n) => /lab/i.test(n)));
  if (labbed.length) return [];
  return [
    {
      code: "CO_ASSESSMENT_MISMATCH",
      location: { source: "spec", section: 7, refs: [] },
      description: "A Lab assessment component is present, but no defined course outcome is marked under Lab (the Lab columns are used by an undefined CO instead).",
      fix: "Mark at least one defined CO in Lab, or move the Lab marks off the extra CO.",
    },
  ];
}

function marksDefect(blueprint: ParsedDoc | null): Defect[] {
  if (!blueprint) return [];
  let maximum: number | null = null;
  let totalMarks: number | null = null;
  for (const t of blueprint.tables) {
    for (const row of t.rows) {
      const label = norm(row[0] ?? "");
      const n = lastNumber(row);
      if (/maximum marks/i.test(label) && n != null) maximum = n;
      if (/^total marks$/i.test(label) && n != null) totalMarks = n;
    }
  }
  if (maximum == null || totalMarks == null || maximum === totalMarks) return [];
  return [
    {
      code: "MARKS_INCONSISTENT",
      location: { source: "blueprint", section: null, refs: [] },
      description: `Blueprint maximum marks (${maximum}) do not match the unit-wise total marks (${totalMarks}).`,
      fix: "Keep the stated maximum marks and flag the unit-wise total.",
    },
  ];
}

function mapTableDefects(spec: ParsedDoc, defined: Set<string>): Defect[] {
  const defects: Defect[] = [];
  const mapCos = new Set<string>();
  for (const t of spec.tables) {
    const blob = t.rows.map((r) => r.join(" ")).join(" ");
    if (!/PO-1/i.test(blob) || !/PSO/i.test(blob)) continue;
    for (const row of t.rows) {
      const idm = norm(row[0] ?? "").match(/^CO\s*[-]?\s*(\d+)$/i);
      if (idm) mapCos.add(coId(idm[1]));
    }
  }
  if (!mapCos.size) return defects;
  for (const id of defined) {
    if (mapCos.has(id)) continue;
    defects.push({
      code: "CO_MISSING_IN_TABLE",
      location: { source: "spec", section: 5, refs: [id] },
      description: `${id} is defined among course outcomes but has no row in the source CO-PO-PSO map.`,
      fix: `Add a row for ${id} in section 5.`,
    });
  }
  for (const id of mapCos) {
    if (defined.has(id)) continue;
    defects.push({
      code: "CO_EXTRA_IN_TABLE",
      location: { source: "spec", section: 5, refs: [id] },
      description: `${id} appears in the source map but is not defined among course outcomes.`,
      fix: `Remove ${id} from the map or add it to section 3.`,
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
  const { hours, interaction, tableTotal } = parseHours(spec);
  defects.push(...hoursDefect(interaction, tableTotal, hours));
  defects.push(...typoDefect(spec));
  defects.push(...labelMismatchDefects(spec, title));
  defects.push(...extraSectionDefects(spec));
  defects.push(...summaryMismatchDefects(summary ? norm(summary) : undefined, units));
  defects.push(...marksDefect(blueprint));
  const definedIds = course_outcomes.map((c) => c.id);
  defects.push(...mapTableDefects(spec, new Set(definedIds)));

  const assessment = parseAssessment(spec, definedIds);
  const bloomByCo = new Map(
    course_outcomes.map((c) => [c.id, bloomFromVerb(c.statement) ?? 3] as const),
  );
  const contentsText = spec.text.match(/Course Contents([\s\S]*?)(?=Course Map|CO-PO)/i)?.[1] ?? "";
  defects.push(...sourceMapRuleDefects(spec, assessment?.co_coverage ?? {}, bloomByCo, contentsText));
  defects.push(...labAssessmentDefect(assessment, definedIds));
  defects.push(...labLabelDefects(units));

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
    skills_text: parseSkillsText(spec),
    unit_topics: parseUnitTopics(blueprint, spec),
    defects,
  };
}

export function extractedToStructured(extracted: Extracted): StructuredCourse {
  return {
    title: extracted.title ?? "",
    code: extracted.code ?? "",
    department: extracted.department ?? "",
    course_type: extracted.course_type ?? "",
    credits_ltp: extracted.credits_ltp ?? "0:0:0",
    summary: extracted.summary ?? "",
    course_outcomes: extracted.course_outcomes,
    units: extracted.units,
    teaching_hours: extracted.teaching_hours ?? { lectures: 0, lab: 0, tests_exams: 0, total: 0 },
    assessment: extracted.assessment ?? { components: [], co_coverage: {} },
    findings: [],
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
    summary: extracted.summary || ai.summary || "",
    course_outcomes: extracted.course_outcomes.length ? extracted.course_outcomes : ai.course_outcomes,
    units: extracted.units.length ? extracted.units : ai.units,
    teaching_hours: extracted.teaching_hours ?? ai.teaching_hours,
    assessment: extracted.assessment ?? ai.assessment,
    findings: ai.findings,
  };
}
