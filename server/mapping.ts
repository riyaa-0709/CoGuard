import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bloomFromVerb, bloomMappingCeiling, leadingVerb } from "./bloom.js";
import type { LlmConfig } from "./llm.js";
import { generateJson } from "./llm.js";
import { MappingAiSchema, type MappingAi, type StructuredCourse } from "./schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const poPso = JSON.parse(readFileSync(join(root, "config/po_pso.json"), "utf8")) as {
  scale: string;
  pos: { id: string; title: string; statement: string }[];
  psos: { id: string; statement: string }[];
};

const MAPPING_RULES = `
Scale: 3 very strong, 2 strong, 1 moderate, blank none. No other values.
Every CO maps to at least one PO. Columns are PO-1..PO-11 and PSO-1, PSO-2 only (no PSO-3).
A CO cannot map more strongly to a PO than its Bloom's level supports (an L2 Explain CO with PO-3 = 3 is wrong).
PO-5 needs real tool use (lab, programming). PO-6 to PO-10 need explicit evidence in the syllabus or assessment; no evidence means blank.
A CO mapped 2 or 3 to PO-3 or PO-5 must be assessed in a practical or assignment component.
Each non-empty cell has a one-line justification.
`.trim();

export async function proposeMap(
  structured: StructuredCourse,
  cosWithBloom: { id: string; statement: string; bloom_level: number | null }[],
  cfg: LlmConfig,
): Promise<MappingAi> {
  const posBlock = poPso.pos.map((p) => `${p.id} ${p.title}: ${p.statement.slice(0, 140)}`).join("\n");
  const psoBlock = poPso.psos.map((p) => `${p.id}: ${p.statement.slice(0, 140)}`).join("\n");
  const cosBlock = cosWithBloom
    .map((c) => {
      const bloom = c.bloom_level != null ? `Bloom L${c.bloom_level}` : "Bloom UNKNOWN — classify from leading verb";
      return `${c.id} [${bloom}]: ${c.statement}`;
    })
    .join("\n");
  const unitsBlock = structured.units
    .map((u) => `Unit ${u.number}: ${u.title}${u.lab ? ` | Lab: ${u.lab.slice(0, 80)}` : ""}`)
    .join("\n");
  const assessBlock = JSON.stringify(structured.assessment);
  const needBloom = cosWithBloom.filter((c) => c.bloom_level == null).map((c) => c.id);

  const prompt = `You build a CO-PO-PSO contribution map and rewrite the course summary.

Mapping rules (follow strictly):
${MAPPING_RULES}
Scale note: ${poPso.scale}

Programme Outcomes:
${posBlock}

Programme Specific Outcomes:
${psoBlock}

Course outcomes:
${cosBlock}

Units / syllabus:
${unitsBlock}

Assessment (use as evidence for PO-3, PO-5, PO-8, PO-9 etc.):
${assessBlock}

Current summary:
${structured.summary}

Tasks:
1) For each CO, for each of PO-1..PO-11 and PSO-1..PSO-2, propose level 1, 2, 3 or "" (blank) with a one-line justification when non-blank.
2) Rewrite summary so it covers all units without inventing topics.
3) findings: only real typo / summary-mismatch issues (codes TYPO_OR_FORMAT, SUMMARY_SYLLABUS_MISMATCH, LABEL_OR_TITLE_MISMATCH, OTHER).
${needBloom.length ? `4) bloom_levels: for ${needBloom.join(", ")} only, set Bloom 1-6 from the leading verb.` : "4) bloom_levels may be {}."}

Return JSON:
{
  "summary": "...",
  "bloom_levels": { "CO-1": 2 },
  "map": { "CO-1": { "PO-1": {"level": 2, "justification": "..."}, "PO-5": {"level": "", "justification": ""} } },
  "findings": [{"code","description","location_section","refs","source"}]
}
Omit blank cells or set level to "".`;

  return generateJson(prompt, MappingAiSchema, cfg);
}

export function attachBloom(
  cos: { id: string; statement: string }[],
  aiBloom: Record<string, number>,
): { id: string; statement: string; bloom_level: number }[] {
  return cos.map((c) => {
    const local = bloomFromVerb(c.statement);
    const fromAi = aiBloom[c.id];
    const bloom_level = local ?? (typeof fromAi === "number" ? fromAi : 3);
    return { ...c, bloom_level };
  });
}

function capLevel(want: number, bloom: number): 1 | 2 | 3 {
  const cap = bloomMappingCeiling(bloom);
  const n = Math.min(Math.max(1, want), cap);
  return n as 1 | 2 | 3;
}

function snippet(statement: string, n = 88): string {
  const s = statement.replace(/^CO[-\s]?\d+[.:)\s]*/i, "").trim();
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, "") + "…";
}

function poMeta(id: string): { title: string; statement: string } {
  if (id.startsWith("PSO-")) {
    const p = poPso.psos.find((x) => x.id === id);
    const statement = p?.statement ?? id;
    const title = statement.split(/[,.]/)[0].trim().slice(0, 70);
    return { title, statement };
  }
  const p = poPso.pos.find((x) => x.id === id);
  return { title: p?.title ?? id, statement: p?.statement ?? id };
}

function justify(
  co: { id: string; statement: string; bloom_level: number },
  col: string,
  level: 1 | 2 | 3,
  why: string,
): string {
  const raw = leadingVerb(co.statement) || "addresses";
  const verb = raw.charAt(0).toUpperCase() + raw.slice(1);
  const words = ["", "moderate", "strong", "very strong"] as const;
  const { title } = poMeta(col);
  return `${co.id} (${verb}, Bloom L${co.bloom_level}) has a ${words[level]} link to ${col} (${title}): ${why}`;
}

function hasPracticalAssessment(comps: string[]): boolean {
  return comps.some((n) => /lab|practical|assignment|programming|project/i.test(n));
}

function relatedUnits(
  statement: string,
  units: { number: number; title: string; lab: string | null }[],
): string {
  const s = statement.toLowerCase();
  const words = s.split(/\W+/).filter((w) => w.length > 3);
  const scored = units.map((u) => {
    const blob = `${u.title} ${u.lab ?? ""}`.toLowerCase();
    let score = 0;
    for (const w of words) if (blob.includes(w)) score += 1;
    if (/algorithm/.test(s) && /algorithm/.test(blob)) score += 2;
    if (/data struct/.test(s) && /data struct/.test(blob)) score += 2;
    if (/flowchart|pseudocode/.test(s) && /problem|flowchart|algorithm/.test(blob)) score += 2;
    if (/program/.test(s) && /program/.test(blob)) score += 1;
    return { u, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.filter((x) => x.score > 0).slice(0, 3);
  const pick = hits.length ? hits : scored.slice(0, 2);
  return pick.map((x) => `Unit ${x.u.number} (${x.u.title})`).join("; ");
}

function assessPhrase(comps: string[]): string {
  const names = [...new Set(comps.filter(Boolean))];
  return names.length ? `assessed in ${names.join(", ")}` : "not marked in a practical/assignment";
}

/**
 * Deterministic CO-PO-PSO map from Bloom verbs, assessment, labs and PO statements.
 * Does not hard-code any course's outcomes or mappings.
 */
export function localMapping(args: {
  cos: { id: string; statement: string; bloom_level: number }[];
  units: { number: number; title: string; lab: string | null }[];
  coverage: Record<string, string[]>;
  skillsText?: string;
}): MappingAi {
  const hasLab = args.units.some((u) => !!u.lab && u.lab.trim().length > 3);
  const unitBlob = args.units.map((u) => `${u.title} ${u.lab ?? ""}`).join(" ").toLowerCase();
  const skills = (args.skillsText ?? "").toLowerCase();
  const labUnits = args.units
    .filter((u) => u.lab && u.lab.trim().length > 3)
    .map((u) => `Unit ${u.number} lab`)
    .slice(0, 4)
    .join(", ");
  const map: MappingAi["map"] = {};

  for (const co of args.cos) {
    const text = co.statement.toLowerCase();
    const comps = args.coverage[co.id] ?? [];
    const practical = hasPracticalAssessment(comps);
    const unitsCite = relatedUnits(co.statement, args.units);
    const assess = assessPhrase(comps);
    const row: Record<string, { level: 1 | 2 | 3 | ""; justification: string }> = {};
    const put = (col: string, want: number, why: string) => {
      const level = capLevel(want, co.bloom_level);
      if ((col === "PO-3" || col === "PO-5") && level >= 2 && !practical) {
        if (col === "PO-5" && hasLab) {
          row[col] = { level: 1, justification: justify(co, col, 1, why) };
        } else if (col === "PO-3") {
          row[col] = { level: 1, justification: justify(co, col, 1, why) };
        }
        return;
      }
      row[col] = { level, justification: justify(co, col, level, why) };
    };

    put(
      "PO-1",
      co.bloom_level >= 6 ? 3 : 2,
      `syllabus ${unitsCite} teaches computing/engineering knowledge for "${snippet(co.statement)}" (${assess})`,
    );

    if (/analys|analyz|problem|identify|select|formulate|compare|evaluat|algorithm|comput/.test(text) || co.bloom_level >= 3) {
      const want = co.bloom_level >= 4 ? 3 : co.bloom_level >= 3 ? 2 : 1;
      put(
        "PO-2",
        want,
        `${leadingVerb(co.statement) || "this outcome"} works on problem analysis in ${unitsCite} — "${snippet(co.statement)}" (${assess})`,
      );
    }

    if (/\b(design|develop|build|implement|apply|solve)(?:s|ed|ing)?\b|\bsolutions?\b/.test(text)) {
      const want = co.bloom_level >= 6 ? 3 : co.bloom_level >= 5 ? 2 : 1;
      put(
        "PO-3",
        want,
        `the leading verb targets design/development of solutions in ${unitsCite} (${assess})`,
      );
    } else if (/program|algorithm|data struct/.test(text)) {
      put(
        "PO-3",
        practical && co.bloom_level >= 5 ? 2 : 1,
        `programming/algorithm/data-structure content in ${unitsCite} feeds solution design (${assess})`,
      );
    }

    if (/investigat|evaluat|compar|experiment|select|analys|analyz/.test(text) && co.bloom_level >= 4) {
      const want = co.bloom_level >= 5 ? 3 : 2;
      put(
        "PO-4",
        want,
        `the outcome investigates alternatives among algorithms/constructs/structures in ${unitsCite} (${assess})`,
      );
    } else if (co.bloom_level >= 6 && /program|solution|algorithm/.test(text)) {
      put(
        "PO-4",
        2,
        `developing solutions requires investigating approaches in ${unitsCite} (${assess})`,
      );
    }

    // Tool use needs an outcome that does something (Apply or above), not one that only explains.
    if (hasLab && co.bloom_level >= 3 && /program|tool|implement|develop|apply|code|comput|lab/.test(`${text} ${unitBlob}`)) {
      const want = practical && co.bloom_level >= 6 ? 3 : practical && co.bloom_level >= 3 ? 2 : 1;
      put(
        "PO-5",
        want,
        `laboratory/programming practice (${labUnits || "listed labs"}) uses modern IT tools for this outcome (${assess})`,
      );
    }

    const soft = (po: string, re: RegExp, why: string) => {
      if (!re.test(`${unitBlob} ${skills} ${comps.join(" ").toLowerCase()}`)) return;
      put(po, 1, why);
    };
    soft("PO-6", /societ|environment|sustainab|health|safety|legal|culture/, "syllabus/assessment mentions societal or environmental context");
    soft("PO-7", /ethic|professional integrity|human values|diversity|inclusion/, "syllabus/assessment mentions ethics or professional values");
    soft("PO-8", /team|group work|collaborat|peer|pair/, "syllabus/assessment mentions teamwork");
    const commSkill = (args.skillsText ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => /communicat|presentation|report|document/i.test(s));
    if (commSkill && comps.some((c) => /assign|report|present|document/i.test(c))) {
      put("PO-9", 1, `assignment work assesses communication (${commSkill})`);
    }
    soft("PO-10", /project management|financ|econom|cost|budget/, "syllabus/assessment mentions project management or finance");

    soft("PO-11", /emerging|life-?long|self-?directed|independent learning/, "syllabus/assessment mentions independent or life-long learning");

    if (/algorithm|program|data struct|comput|code|software/.test(text) || hasLab) {
      put(
        "PSO-1",
        co.bloom_level >= 3 ? 3 : 2,
        `computing fundamentals, algorithms or data structures in ${unitsCite} — "${snippet(co.statement)}" (${assess})`,
      );
      put(
        "PSO-2",
        co.bloom_level >= 6 ? 3 : co.bloom_level >= 3 ? 2 : 1,
        `software practice via ${labUnits || unitsCite} and ${assess}`,
      );
    }

    map[co.id] = row;
  }

  return {
    summary: summaryCoveringUnits("", args.units),
    bloom_levels: Object.fromEntries(args.cos.map((c) => [c.id, c.bloom_level])),
    map,
    findings: [],
  };
}

export function summaryCoveringUnits(
  base: string,
  units: { number: number; title: string; lab?: string | null }[],
  topics: Record<number, string> = {},
): string {
  const titles = units.map((u) => u.title.trim()).filter((t) => t.length >= 3);
  const intro = base.replace(/\s+/g, " ").trim();
  // With unit topics, rewrite the summary around the units: the old opening sentence, then one sentence per unit.
  if (units.length && units.every((u) => topics[u.number])) {
    const opening = intro.match(/^[^.]*\./)?.[0] ?? "This course develops the knowledge and skills listed in the course outcomes.";
    const perUnit = units.map((u) => `${u.title} covers ${topicPhrases(topics[u.number])}.`);
    const labNote = units.some((u) => !!u.lab && String(u.lab).trim()) ? " Laboratory exercises give hands-on practice in each unit." : "";
    return `${opening} ${perUnit.join(" ")}${labNote}`;
  }
  const mentioned = titles.length > 0 && titles.every((t) => intro.toLowerCase().includes(t.toLowerCase()));
  if (intro && mentioned) return intro;
  const cover =
    titles.length <= 2
      ? titles.join(" and ")
      : `${titles.slice(0, -1).join("; ")}; and ${titles[titles.length - 1]}`;
  const labNote = units.some((u) => !!u.lab && String(u.lab).trim().length > 0) ? ", including laboratory exercises" : "";
  const lead = intro || "This course develops the knowledge and skills listed in the course outcomes.";
  if (!cover) return lead;
  return `${lead} The syllabus covers ${cover}${labNote}.`;
}

// The first three short topic phrases of a unit, joined as "a, b and c".
function topicPhrases(text: string): string {
  const phrases = text
    .split(/[.;]\s+|,\s*/)
    .map((p) => p.replace(/\s+/g, " ").trim().replace(/\.$/, ""))
    .filter((p) => p.length >= 4 && p.length <= 95 && /[a-z]/i.test(p))
    .slice(0, 3)
    .map((p) => (/^[A-Z][a-z]/.test(p) ? p[0].toLowerCase() + p.slice(1) : p));
  return phrases.length <= 1 ? (phrases[0] ?? "its listed topics") : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}
