import type { Aggregate, QuestionAggregates, Survey, SurveyPage, SurveyQuestion } from "../../../shared/types";

export type { SurveyQuestion };

export type SurveyPageConfig = SurveyPage;

export type PagedSurvey = Survey & {
  pages?: SurveyPageConfig[];
  terms_enabled?: boolean;
  terms_text?: string;
  use_aggregated_shapes?: boolean;
  map_palette?: string;
};

export type QuestionAggregate = Aggregate & {
  question_id?: string;
};

export type GroupedAggregate = {
  question_id: string;
  question_text: string;
  min_rating?: number;
  max_rating?: number;
  aggregates: QuestionAggregate[];
};

export type AggregateResponse = QuestionAggregates[] | QuestionAggregate[] | { questions: GroupedAggregate[] };

export async function apiGet<T>(path: string, token?: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: token ? { "x-admin-token": token } : undefined
  });
  return parseResponse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-admin-token": token } : {})
    },
    body: JSON.stringify(body)
  });
  return parseResponse<T>(response);
}

export async function getActiveSurvey(): Promise<Survey> {
  return apiGet<Survey>("/api/survey/active");
}

export async function getAggregates(surveyId: string): Promise<AggregateResponse> {
  return apiGet<AggregateResponse>(`/api/results/${encodeURIComponent(surveyId)}`);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Request failed with ${response.status}`);
  }
  return data as T;
}
