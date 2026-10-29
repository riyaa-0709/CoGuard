import { z } from "zod";

export const StructuredCourseSchema = z.object({
  title: z.string(),
  code: z.string(),
  department: z.string(),
  credits_ltp: z.string().regex(/^\d+:\d+:\d+$/),
  course_type: z.string(),
  summary: z.string(),
  course_outcomes: z
    .array(
      z.object({
        id: z.string().regex(/^CO-\d+$/),
        statement: z.string(),
      }),
    )
    .min(1),
  units: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      lab: z.string().nullable(),
    }),
  ),
  teaching_hours: z.object({
    lectures: z.number(),
    lab: z.number(),
    tests_exams: z.number(),
    total: z.number(),
  }),
  assessment: z.object({
    components: z.array(
      z.object({
        name: z.string(),
        weight_percent: z.number(),
      }),
    ),
    co_coverage: z.record(z.array(z.string())),
  }),
  findings: z
    .array(
      z.object({
        code: z.enum(["TYPO_OR_FORMAT", "SUMMARY_SYLLABUS_MISMATCH", "LABEL_OR_TITLE_MISMATCH", "OTHER"]),
        description: z.string(),
        location_section: z.number().int().min(1).max(12).nullable().optional(),
        refs: z.array(z.string()).optional(),
        source: z.enum(["spec", "blueprint", "template"]).optional(),
      }),
    )
    .default([]),
});
export type StructuredCourse = z.output<typeof StructuredCourseSchema>;

const MapLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(""), z.null()]);

export const MappingAiSchema = z.object({
  summary: z.string(),
  bloom_levels: z
    .record(z.number().int().min(1).max(6))
    .optional()
    .default({}),
  map: z.record(
    z.record(
      z.object({
        level: MapLevelSchema,
        justification: z.string().default(""),
      }),
    ),
  ),
  findings: z
    .array(
      z.object({
        code: z.enum(["TYPO_OR_FORMAT", "SUMMARY_SYLLABUS_MISMATCH", "LABEL_OR_TITLE_MISMATCH", "OTHER"]),
        description: z.string(),
        location_section: z.number().int().min(1).max(12).nullable().optional(),
        refs: z.array(z.string()).optional(),
        source: z.enum(["spec", "blueprint", "template"]).optional(),
      }),
    )
    .default([]),
});
export type MappingAi = z.output<typeof MappingAiSchema>;

export const DEFECT_CODES = [
  "CO_MISSING_IN_TABLE",
  "CO_EXTRA_IN_TABLE",
  "CO_ASSESSMENT_MISMATCH",
  "PSO_COLUMN_MISMATCH",
  "MAPPING_BLOOM_MISMATCH",
  "MAPPING_UNSUPPORTED",
  "WRONG_TEMPLATE",
  "PLACEHOLDER_TEXT",
  "SUMMARY_SYLLABUS_MISMATCH",
  "LABEL_OR_TITLE_MISMATCH",
  "HOURS_INCONSISTENT",
  "WEIGHTAGE_INCONSISTENT",
  "TYPO_OR_FORMAT",
  "SECTION_NOT_IN_TEMPLATE",
  "MARKS_INCONSISTENT",
  "OTHER",
] as const;

export const DefectSchema = z.object({
  code: z.enum(DEFECT_CODES),
  location: z.object({
    source: z.enum(["spec", "blueprint", "template"]),
    section: z.number().int().min(1).max(12).nullable(),
    refs: z.array(z.string()).default([]),
  }),
  description: z.string(),
  fix: z.string(),
});

export const SpecforgeOutputSchema = z
  .object({
    schema_version: z.literal("1.0"),
    input_id: z.string(),
    template: z.enum(["integrated", "non_lab"]),
    course: z.object({
      title: z.string(),
      code: z.string(),
      department: z.string(),
      credits_ltp: z.string().regex(/^\d+:\d+:\d+$/),
      course_type: z.string(),
      summary: z.string(),
    }),
    course_outcomes: z
      .array(
        z.object({
          id: z.string().regex(/^CO-\d+$/),
          statement: z.string(),
          bloom_level: z.number().int().min(1).max(6),
        }),
      )
      .min(1),
    units: z.array(
      z.object({
        number: z.number().int(),
        title: z.string(),
        lab: z.string().nullable(),
      }),
    ),
    co_po_pso_map: z.record(
      z.record(
        z
          .object({
            level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
            justification: z.string(),
          })
          .nullable(),
      ),
    ),
    teaching_hours: z.object({
      lectures: z.number(),
      lab: z.number(),
      tests_exams: z.number(),
      total: z.number(),
    }),
    assessment: z.object({
      components: z.array(
        z.object({
          name: z.string(),
          weight_percent: z.number(),
        }),
      ),
      co_coverage: z.record(z.array(z.string())),
    }),
    defects: z.array(DefectSchema),
  })
  .strict();

export type SpecforgeOutput = z.infer<typeof SpecforgeOutputSchema>;
export type Defect = z.infer<typeof DefectSchema>;
