import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmConfig } from "./llm.js";
import { generateJson } from "./llm.js";
import { bloomFromVerb } from "./bloom.js";
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
  const posBlock = poPso.pos.map((p) => `${p.id} (${p.title}): ${p.statement}`).join("\n");
  const psoBlock = poPso.psos.map((p) => `${p.id}: ${p.statement}`).join("\n");
  const cosBlock = cosWithBloom
    .map((c) => {
      const bloom = c.bloom_level != null ? `Bloom L${c.bloom_level}` : "Bloom UNKNOWN — classify from leading verb";
      return `${c.id} [${bloom}]: ${c.statement}`;
    })
    .join("\n");
  const unitsBlock = structured.units
    .map((u) => `Unit ${u.number}: ${u.title}${u.lab ? ` | Lab: ${u.lab}` : ""}`)
    .join("\n");
  const assessBlock = JSON.stringify(structured.assessment, null, 2);
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
