export type Survey = {
  id: string;
  title: string;
  question_text: string;
  min_rating: number;
  max_rating: number;
  is_active?: boolean;
};

export type Aggregate = {
  postal_code: string;
  count: number;
  average: number | null;
  sum: number;
  hidden?: boolean;
};
