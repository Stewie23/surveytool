import { FormEvent, useEffect, useState } from "react";
import type { Survey } from "../../../shared/types";
import { PostalCodeInput } from "../components/PostalCodeInput";
import { RatingScale } from "../components/RatingScale";
import { apiPost, getActiveSurvey } from "../lib/api";
import { isValidPostalCode } from "../lib/validation";

export function SurveyPage() {
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [postalCode, setPostalCode] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getActiveSurvey().then(setSurvey).catch((error) => setStatus(error.message));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!survey || rating === null) {
      setStatus("Choose a rating.");
      return;
    }
    if (!isValidPostalCode(postalCode)) {
      setStatus("Enter a valid 5-digit postal code.");
      return;
    }

    setLoading(true);
    setStatus("");
    try {
      await apiPost("/api/responses", {
        survey_id: survey.id,
        postal_code: postalCode,
        rating
      });
      localStorage.setItem(`submitted:${survey.id}`, "true");
      setStatus("Thanks, your response was submitted.");
      setRating(null);
      setPostalCode("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Submission failed.");
    } finally {
      setLoading(false);
    }
  }

  if (!survey) {
    return <section className="panel">Loading survey...</section>;
  }

  const alreadySubmitted = localStorage.getItem(`submitted:${survey.id}`) === "true";

  return (
    <section className="panel survey-panel">
      <p className="eyebrow">Active survey</p>
      <h1>{survey.title}</h1>
      <p className="question">{survey.question_text}</p>
      {alreadySubmitted ? <p className="notice">This browser already submitted for this survey.</p> : null}
      <form onSubmit={submit}>
        <RatingScale min={survey.min_rating} max={survey.max_rating} value={rating} onChange={setRating} />
        <PostalCodeInput value={postalCode} onChange={setPostalCode} />
        <button className="primary" type="submit" disabled={loading}>
          {loading ? "Submitting..." : "Submit response"}
        </button>
      </form>
      {status ? <p role="status" className={status.startsWith("Thanks") ? "success" : "error"}>{status}</p> : null}
    </section>
  );
}
