import { bloomMappingCeiling } from "./bloom.js";
import type { Defect } from "./schema.js";

export type MapCell = { level: 1 | 2 | 3; justification: string };
export type CoPoMap = Record<string, Record<string, MapCell>>;

const PO_COLS = Array.from({ length: 11 }, (_, i) => `PO-${i + 1}`);
const PSO_COLS = ["PSO-1", "PSO-2"];
const ALLOWED_COLS = new Set([...PO_COLS, ...PSO_COLS]);

function isPracticalOrAssignment(name: string): boolean {
  return /lab|practical|assignment|programming|project/i.test(name);
}

function hasLabOrProgrammingEvidence(
  coId: string,
  coverage: Record<string, string[]>,
  units: { lab: string | null }[],
): boolean {
  const comps = coverage[coId] ?? [];
  if (comps.some((c) => /lab|practical|programming|computer/i.test(c))) return true;
  return units.some((u) => !!u.lab && u.lab.trim().length > 0);
}

function hasEvidenceForSoftPo(
  po: string,
  coId: string,
  coverage: Record<string, string[]>,
  unitsText: string,
): boolean {
  const comps = (coverage[coId] ?? []).join(" ").toLowerCase();
  const blob = `${unitsText} ${comps}`.toLowerCase();
  if (po === "PO-6") return /societ|environment|sustainab|ethic|health|safety|legal|culture/.test(blob);
  if (po === "PO-7") return /ethic|professional|integrity|values|diversity|inclusion|law/.test(blob);
  if (po === "PO-8") return /team|group|collaborat|peer|pair/.test(blob);
  if (po === "PO-9") return /communicat|present|report|document|verbal/.test(blob);
  if (po === "PO-10") return /project management|financ|econom|cost|budget|manage project/.test(blob);
  return false;
}

export function clampMap(args: {
  raw: Record<string, Record<string, { level: 1 | 2 | 3 | "" | null; justification?: string }>>;
  cos: { id: string; bloom_level: number }[];
  co_coverage: Record<string, string[]>;
  units: { lab: string | null; title: string }[];
  evidenceText?: string;
}): { map: CoPoMap; defects: Defect[] } {
  const defects: Defect[] = [];
  const map: CoPoMap = {};
  const unitsText = `${args.units.map((u) => `${u.title} ${u.lab ?? ""}`).join(" ")} ${args.evidenceText ?? ""}`;

  for (const co of args.cos) {
    map[co.id] = {};
    const rawRow = args.raw[co.id] ?? {};
    const ceiling = bloomMappingCeiling(co.bloom_level);

    for (const [col, cell] of Object.entries(rawRow)) {
      if (!ALLOWED_COLS.has(col)) {
        defects.push({
          code: "PSO_COLUMN_MISMATCH",
          location: { source: "spec", section: 5, refs: [co.id, col] },
          description: `Unsupported column ${col} in CO-PO-PSO map.`,
          fix: `Removed ${col}; only PSO-1 and PSO-2 are kept.`,
        });
        continue;
      }
      let level: 1 | 2 | 3 | null = null;
      const rawLevel = cell?.level;
      if (rawLevel === 1 || rawLevel === 2 || rawLevel === 3) level = rawLevel;
      else if (rawLevel !== "" && rawLevel != null) {
        defects.push({
          code: "MAPPING_UNSUPPORTED",
          location: { source: "spec", section: 5, refs: [co.id, col] },
          description: `Invalid mapping value for ${co.id}/${col}; blanked.`,
          fix: "Set cell to blank (only 1, 2, 3 allowed).",
        });
        level = null;
      }
      if (level == null) continue;

      if (level > ceiling) {
        defects.push({
          code: "MAPPING_BLOOM_MISMATCH",
          location: { source: "spec", section: 5, refs: [co.id, col] },
          description: `${co.id} is Bloom L${co.bloom_level} but was mapped ${level} to ${col}.`,
          fix: `Clamped to ${ceiling} to respect Bloom ceiling.`,
        });
        level = ceiling;
      }

      if (col === "PO-5" && !hasLabOrProgrammingEvidence(co.id, args.co_coverage, args.units)) {
        defects.push({
          code: "MAPPING_UNSUPPORTED",
          location: { source: "spec", section: 5, refs: [co.id, "PO-5"] },
          description: `PO-5 requires lab/programming evidence for ${co.id}; blanked.`,
          fix: "Cleared PO-5 mapping.",
        });
        continue;
      }

      if (/^PO-(6|7|8|9|10)$/.test(col) && !hasEvidenceForSoftPo(col, co.id, args.co_coverage, unitsText)) {
        defects.push({
          code: "MAPPING_UNSUPPORTED",
          location: { source: "spec", section: 5, refs: [co.id, col] },
          description: `No syllabus/assessment evidence for ${co.id}→${col}; blanked.`,
          fix: `Cleared ${col} mapping.`,
        });
        continue;
      }

      if ((col === "PO-3" || col === "PO-5") && level >= 2) {
        const comps = args.co_coverage[co.id] ?? [];
        if (!comps.some(isPracticalOrAssignment)) {
          defects.push({
            code: "MAPPING_UNSUPPORTED",
            location: { source: "spec", section: 5, refs: [co.id, col] },
            description: `${co.id} mapped ${level} to ${col} but is not assessed in a practical/assignment; blanked.`,
            fix: `Cleared ${col} or reduce level after adding practical/assignment coverage.`,
          });
          continue;
        }
      }

      const justification = (cell?.justification ?? "").trim() || `Supports ${col} at level ${level}.`;
      map[co.id][col] = { level, justification };
    }

    // Ensure at least one PO
    const hasPo = Object.keys(map[co.id]).some((k) => k.startsWith("PO-"));
    if (!hasPo) {
      map[co.id]["PO-1"] = {
        level: 1,
        justification: "Minimum PO coverage applied after clamp removed all PO links.",
      };
      defects.push({
        code: "MAPPING_UNSUPPORTED",
        location: { source: "spec", section: 5, refs: [co.id, "PO-1"] },
        description: `${co.id} had no PO mapping after clamp; set PO-1=1.`,
        fix: "Assigned moderate contribution to PO-1.",
      });
    }
  }

  return { map, defects };
}
