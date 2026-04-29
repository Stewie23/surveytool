import { z } from "zod";

export const adminSurveySchema = z.object({
  title: z.string().trim().min(1).max(160),
  question_text: z.string().trim().min(1).max(500),
  min_rating: z.number().int(),
  max_rating: z.number().int(),
  is_active: z.boolean().default(true)
}).refine((value) => value.min_rating < value.max_rating, {
  message: "min_rating must be lower than max_rating"
}).refine((value) => value.max_rating - value.min_rating + 1 <= 21, {
  message: "rating range can contain at most 21 values"
});

export const responseSchema = z.object({
  survey_id: z.string().trim().min(1),
  postal_code: z.string().regex(/^\d{5}$/),
  rating: z.number().int()
});

export const surveyIdParamsSchema = z.object({
  surveyId: z.string().trim().min(1)
});
