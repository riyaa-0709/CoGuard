import type { CoPoMap } from "./clamp.js";
import type { Defect, SpecforgeOutput } from "./schema.js";
import type { TemplateKind } from "./templateChoice.js";
import { chooseTemplate } from "./templateChoice.js";

export function validateV1toV10(args: {
  output: Omit<SpecforgeOutput, "defects">;
  map: CoPoMap;
  sampleStrings: string[];
  html: string;
  template: TemplateKind;
}): Defect[] {
  const defects: Defect[] = [];
  const cos = args.output.course_outcomes.map((c) => c.id);
  const coSet = new Set(cos);
  const mapCos = Object.keys(args.map);
  const coverageCos = Object.keys(args.output.assessment.co_coverage);

  // V1: CO count identical in sections 3, 5, 7
  if (mapCos.length !== cos.length) {
    const missing = cos.filter((id) => !mapCos.includes(id));
    const extra = mapCos.filter((id) => !coSet.has(id));
    for (const id of missing) {
      defects.push({
        code: "CO_MISSING_IN_TABLE",
        location: { source: "spec", section: 5, refs: [id] },
        description: `${id} is in section 3 but missing from the CO-PO-PSO map (section 5).`,
        fix: `Add a row for ${id} in section 5.`,
      });
    }
    for (const id of extra) {
      defects.push({
        code: "CO_EXTRA_IN_TABLE",
        location: { source: "spec", section: 5, refs: [id] },
        description: `${id} appears in section 5 but is not defined in section 3.`,
        fix: `Remove ${id} from the map or add it to section 3.`,
      });
    }
  }
  for (const id of cos) {
    if (!coverageCos.includes(id)) {
      defects.push({
        code: "CO_MISSING_IN_TABLE",
        location: { source: "spec", section: 7, refs: [id] },
        description: `${id} is in section 3 but missing from assessment coverage (section 7).`,
        fix: `Mark ${id} in at least one assessment component.`,
      });
    }
  }
  for (const id of coverageCos) {
    if (!coSet.has(id)) {
      defects.push({
        code: "CO_EXTRA_IN_TABLE",
        location: { source: "spec", section: 7, refs: [id] },
        description: `${id} appears in assessment coverage but is not defined in section 3.`,
        fix: `Remove ${id} from section 7 or add it to section 3.`,
      });
    }
  }

  // V2: every CO mapped to at least one PO
  for (const id of cos) {
    const row = args.map[id] ?? {};
    const hasPo = Object.keys(row).some((k) => k.startsWith("PO-"));
    if (!hasPo) {
      defects.push({
        code: "CO_MISSING_IN_TABLE",
        location: { source: "spec", section: 5, refs: [id] },
        description: `${id} is not mapped to any PO.`,
        fix: `Map ${id} to at least one PO.`,
      });
    }
  }

  // V3: every CO assessed
  for (const id of cos) {
    const comps = args.output.assessment.co_coverage[id] ?? [];
    if (!comps.length) {
      defects.push({
        code: "CO_ASSESSMENT_MISMATCH",
        location: { source: "spec", section: 7, refs: [id] },
        description: `${id} is not assessed in any component.`,
        fix: `Assess ${id} in at least one CE/SEE/Lab component.`,
      });
    }
  }

  // V4: no CO id outside section 3 (already covered via extras)

  // V5: teaching hours add up (interaction total may equal lectures+lab, with tests extra)
  const th = args.output.teaching_hours;
  const sum = th.lectures + th.lab + th.tests_exams;
  const taught = th.lectures + th.lab;
  if (Math.abs(sum - th.total) > 0.01 && Math.abs(taught - th.total) > 0.01) {
    defects.push({
      code: "HOURS_INCONSISTENT",
      location: { source: "spec", section: 6, refs: [] },
      description: `Teaching hours ${th.lectures}+${th.lab}+${th.tests_exams}=${sum} but total is ${th.total}.`,
      fix: "Correct component hours or the total so they match.",
    });
  }

  // V6: CE + end-exam (+lab) weightages ~ 100
  const weights = args.output.assessment.components.reduce((a, c) => a + c.weight_percent, 0);
  if (Math.abs(weights - 100) > 0.5) {
    defects.push({
      code: "WEIGHTAGE_INCONSISTENT",
      location: { source: "spec", section: 7, refs: [] },
      description: `Assessment component weightages sum to ${weights}, not 100.`,
      fix: "Adjust CE / SEE / Lab weightages to total 100%.",
    });
  }

  // V7: no template sample text in html
  for (const sample of args.sampleStrings) {
    const s = sample.trim();
    if (s.length < 4) continue;
    if (args.html.includes(s)) {
      defects.push({
        code: "PLACEHOLDER_TEXT",
        location: { source: "template", section: null, refs: [] },
        description: `Template sample text still present: "${s.slice(0, 80)}"`,
        fix: "Replace leftover sample content with course data.",
      });
    }
  }

  // V8: PSO columns only PSO-1 / PSO-2
  for (const [coId, row] of Object.entries(args.map)) {
    for (const col of Object.keys(row)) {
      if (col.startsWith("PSO-") && col !== "PSO-1" && col !== "PSO-2") {
        defects.push({
          code: "PSO_COLUMN_MISMATCH",
          location: { source: "spec", section: 5, refs: [coId, col] },
          description: `Unexpected PSO column ${col}.`,
          fix: "Use only PSO-1 and PSO-2.",
        });
      }
    }
  }

  // V9: mapping values / bloom / strong PO-3/PO-5 (clamp already enforces; re-check levels)
  for (const [coId, row] of Object.entries(args.map)) {
    for (const [col, cell] of Object.entries(row)) {
      if (!cell) continue;
      if (![1, 2, 3].includes(cell.level)) {
        defects.push({
          code: "MAPPING_UNSUPPORTED",
          location: { source: "spec", section: 5, refs: [coId, col] },
          description: `Invalid level for ${coId}/${col}.`,
          fix: "Use only 1, 2, 3 or blank.",
        });
      }
      if (!cell.justification?.trim()) {
        defects.push({
          code: "MAPPING_UNSUPPORTED",
          location: { source: "spec", section: 5, refs: [coId, col] },
          description: `Missing justification for ${coId}/${col}.`,
          fix: "Add a one-line justification.",
        });
      }
    }
  }

  // V10: template choice consistent
  const expected = chooseTemplate(args.output.course.credits_ltp, args.output.course.course_type);
  if (expected.template !== args.template) {
    defects.push({
      code: "WRONG_TEMPLATE",
      location: { source: "template", section: null, refs: [] },
      description: `Template is ${args.template} but credits/type imply ${expected.template} (${expected.signals.join("; ")}).`,
      fix: `Switch to the ${expected.template} template or record an override reason.`,
    });
  }

  return defects;
}
