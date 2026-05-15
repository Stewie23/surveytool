export type MapLodLevel = 1 | 2 | 3 | 4 | 5;

export type Survey = {
  id: string;
  title: string;
  pages: SurveyPage[];
  terms_enabled: boolean;
  terms_text: string;
  start_text: string;
  start_logo_data_url: string;
  thank_you_text: string;
  use_aggregated_shapes: boolean;
  map_lod_levels?: MapLodLevel[];
  map_palette?: string;
  is_active?: boolean;
  question_text?: string;
  min_rating?: number;
  max_rating?: number;
  rating_labels?: Record<string, string>;
};

export type SurveyPage = {
  id: string;
  title: string;
  questions: SurveyQuestion[];
};

export type SurveyQuestion = {
  id: string;
  text: string;
  min_rating: number;
  max_rating: number;
  rating_labels?: Record<string, string>;
};

export type Aggregate = {
  question_id: string;
  postal_code: string;
  count: number;
  average: number | null;
  sum: number;
  hidden?: boolean;
};

export type QuestionAggregates = {
  question_id: string;
  aggregates: Aggregate[];
};
