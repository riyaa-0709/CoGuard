import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const verbs = JSON.parse(readFileSync(join(root, "config/bloom_verbs.json"), "utf8")) as Record<string, string[]>;

const verbToLevel = new Map<string, number>();
for (const [key, list] of Object.entries(verbs)) {
  const n = Number(key.replace(/^L/i, ""));
  for (const v of list) verbToLevel.set(v.toLowerCase(), n);
}

export function leadingVerb(statement: string): string {
  const cleaned = statement.replace(/^CO[-\s]?\d+[.:)\s]*/i, "").trim();
  const m = cleaned.match(/^([A-Za-z]+)/);
  return (m?.[1] ?? "").toLowerCase();
}

export function bloomFromVerb(statement: string): number | null {
  const verb = leadingVerb(statement);
  return verbToLevel.get(verb) ?? null;
}

/** Max allowed mapping strength for a CO's Bloom level. */
export function bloomMappingCeiling(bloom: number): 1 | 2 | 3 {
  if (bloom <= 1) return 1;
  if (bloom <= 2) return 2;
  return 3;
}
