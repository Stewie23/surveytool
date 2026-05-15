import { z } from "zod";
import { DEFAULT_MAP_PALETTE, MAP_PALETTE_IDS } from "../shared/mapPalettes.js";

const ALL_MAP_LOD_LEVELS = [1, 2, 3, 4, 5] as const;

const ratingLabelsSchema = z.record(z.string().regex(/^-?\d+$/), z.string().trim().max(80));

const idSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const imageDataUrlSchema = z.string()
  .max(750_000)
  .regex(/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/)
  .or(z.literal(""));

const questionSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1).max(500),
  min_rating: z.number().int(),
  max_rating: z.number().int(),
  rating_labels: ratingLabelsSchema.default({})
}).refine((value) => value.min_rating < value.max_rating, {
  message: "min_rating must be lower than max_rating"
}).refine((value) => value.max_rating - value.min_rating + 1 <= 21, {
  message: "rating range can contain at most 21 values"
}).transform((value) => ({
  ...value,
  rating_labels: Object.fromEntries(
    Object.entries(value.rating_labels).filter(([rating, label]) => {
      const parsedRating = Number(rating);
      return label.length > 0 && parsedRating >= value.min_rating && parsedRating <= value.max_rating;
    })
  )
}));

const pageSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(160),
  questions: z.array(questionSchema).min(1)
}).superRefine((value, ctx) => {
  const questionIds = new Set<string>();
  for (const question of value.questions) {
    if (questionIds.has(question.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate question id: ${question.id}`,
        path: ["questions"]
      });
    }
    questionIds.add(question.id);
  }
});

const mapLodLevelsSchema = z.array(z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
])).min(1).superRefine((levels, ctx) => {
  if (new Set(levels).size === levels.length) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "map_lod_levels must contain unique levels"
  });
});

export const responseSchema = z.object({
  survey_id: z.string().trim().min(1),
  postal_code: z.string().regex(/^\d{5}$/),
  answers: z.array(z.object({
    question_id: idSchema,
    rating: z.number().int()
  })).min(1),
  terms_accepted: z.boolean().optional()
});

export const adminSurveySchema = z.object({
  title: z.string().trim().min(1).max(160),
  pages: z.array(pageSchema).min(1),
  is_active: z.boolean().default(true),
  start_text: z.string().trim().max(800).default(""),
  start_logo_data_url: imageDataUrlSchema.default(""),
  terms_enabled: z.boolean().default(false),
  terms_text: z.string().trim().max(5000).default(""),
  use_aggregated_shapes: z.boolean().default(false),
  map_lod_levels: mapLodLevelsSchema.optional(),
  map_palette: z.enum(MAP_PALETTE_IDS).default(DEFAULT_MAP_PALETTE)
}).superRefine((value, ctx) => {
  const pageIds = new Set<string>();
  const questionIds = new Set<string>();
  for (const page of value.pages) {
    if (pageIds.has(page.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate page id: ${page.id}`,
        path: ["pages"]
      });
    }
    pageIds.add(page.id);

    for (const question of page.questions) {
      if (questionIds.has(question.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate question id: ${question.id}`,
          path: ["pages"]
        });
      }
      questionIds.add(question.id);
    }
  }
}).transform((value) => {
  const mapLodLevels = value.map_lod_levels ?? (value.use_aggregated_shapes ? [...ALL_MAP_LOD_LEVELS] : [5]);
  return {
    ...value,
    use_aggregated_shapes: mapLodLevels.some((level) => level < 5),
    map_lod_levels: mapLodLevels
  };
});

export const surveyIdParamsSchema = z.object({
  surveyId: z.string().trim().min(1)
});

export const randomResponsesSchema = z.object({
  count: z.number().int().min(1).max(10000)
});
