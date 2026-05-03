import { FormEvent, useEffect, useMemo, useState } from "react";
import { PostalCodeInput } from "../components/PostalCodeInput";
import { RatingScale } from "../components/RatingScale";
import { apiPost, getActiveSurvey, type PagedSurvey, type SurveyPageConfig } from "../lib/api";
import { isValidPostalCode } from "../lib/validation";

function normalizeSurvey(survey: PagedSurvey): PagedSurvey & { pages: SurveyPageConfig[] } {
  return {
    ...survey,
    pages: survey.pages?.length
      ? survey.pages
      : [{
        id: "page-default",
        title: "Page 1",
        questions: [{
          id: "question-default",
          text: survey.question_text,
          min_rating: survey.min_rating,
          max_rating: survey.max_rating,
          rating_labels: survey.rating_labels ?? {}
        }]
      }]
  };
}

export function SurveyPage() {
  const [survey, setSurvey] = useState<(PagedSurvey & { pages: SurveyPageConfig[] }) | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [postalCode, setPostalCode] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getActiveSurvey()
      .then((loaded) => setSurvey(normalizeSurvey(loaded as PagedSurvey)))
      .catch((error) => setStatus(error.message));
  }, []);

  const currentPage = survey?.pages[pageIndex];
  const isTermsStep = Boolean(survey?.terms_enabled) && pageIndex >= (survey?.pages.length ?? 0);
  const isLastQuestionPage = survey ? pageIndex === survey.pages.length - 1 : false;
  const answeredCurrentPage = useMemo(
    () => currentPage?.questions.every((question) => answers[question.id] !== undefined) ?? false,
    [answers, currentPage]
  );

  async function submit() {
    if (!survey) return;
    const orderedAnswers = survey.pages.flatMap((page) => page.questions.map((question) => ({
      question_id: question.id,
      rating: answers[question.id]
    })));

    if (orderedAnswers.some((answer) => answer.rating === undefined)) {
      setStatus("Answer every question.");
      return;
    }
    if (!isValidPostalCode(postalCode)) {
      setStatus("Enter a valid 5-digit postal code.");
      return;
    }
    if (survey.terms_enabled && !acceptedTerms) {
      setStatus("Accept the terms to submit.");
      return;
    }

    setLoading(true);
    setStatus("");
    try {
      await apiPost("/api/responses", {
        survey_id: survey.id,
        postal_code: postalCode,
        rating: orderedAnswers[0]?.rating,
        answers: orderedAnswers,
        terms_accepted: survey.terms_enabled ? acceptedTerms : false
      });
      localStorage.setItem(`submitted:${survey.id}`, "true");
      setStatus("Thanks, your response was submitted.");
      setAnswers({});
      setPostalCode("");
      setAcceptedTerms(false);
      setPageIndex(0);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Submission failed.");
    } finally {
      setLoading(false);
    }
  }

  function handleContinue(event: FormEvent) {
    event.preventDefault();
    if (!survey || !currentPage) return;
    if (!answeredCurrentPage) {
      setStatus("Answer every question on this page.");
      return;
    }
    if (!isValidPostalCode(postalCode)) {
      setStatus("Enter a valid 5-digit postal code.");
      return;
    }

    setStatus("");
    if (isLastQuestionPage && survey.terms_enabled) {
      setPageIndex(survey.pages.length);
      return;
    }
    if (isLastQuestionPage) {
      submit();
      return;
    }
    setPageIndex(pageIndex + 1);
  }

  function handleTermsSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  if (!survey) {
    return <section className="panel">Loading survey...</section>;
  }

  const alreadySubmitted = localStorage.getItem(`submitted:${survey.id}`) === "true";

  return (
    <section className="panel survey-panel">
      <p className="eyebrow">Active survey</p>
      <h1>{survey.title}</h1>
      {alreadySubmitted ? <p className="notice">This browser already submitted for this survey.</p> : null}

      {isTermsStep ? (
        <form onSubmit={handleTermsSubmit} className="survey-form">
          <div>
            <p className="eyebrow">Terms</p>
            <div className="terms-box">{survey.terms_text}</div>
          </div>
          <label className="check">
            <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} />
            I accept the terms
          </label>
          <div className="survey-actions">
            <button type="button" onClick={() => setPageIndex(survey.pages.length - 1)}>Back</button>
            <button className="primary" type="submit" disabled={loading || !acceptedTerms}>
              {loading ? "Submitting..." : "Submit response"}
            </button>
          </div>
        </form>
      ) : currentPage ? (
        <form onSubmit={handleContinue} className="survey-form">
          <div className="survey-progress">
            <span>Page {pageIndex + 1} of {survey.pages.length}</span>
            <strong>{currentPage.title}</strong>
          </div>
          {currentPage.questions.map((question) => (
            <fieldset className="question-block" key={question.id}>
              <legend>{question.text}</legend>
              <RatingScale
                min={question.min_rating}
                max={question.max_rating}
                labels={question.rating_labels}
                value={answers[question.id] ?? null}
                onChange={(rating) => setAnswers({ ...answers, [question.id]: rating })}
              />
              {answers[question.id] === undefined ? <span className="field__hint">Required</span> : null}
            </fieldset>
          ))}
          {pageIndex === 0 ? <PostalCodeInput value={postalCode} onChange={setPostalCode} /> : null}
          <div className="survey-actions">
            <button type="button" onClick={() => setPageIndex(Math.max(0, pageIndex - 1))} disabled={pageIndex === 0 || loading}>
              Back
            </button>
            <button className="primary" type="submit" disabled={loading}>
              {loading ? "Submitting..." : isLastQuestionPage && !survey.terms_enabled ? "Submit response" : "Continue"}
            </button>
          </div>
        </form>
      ) : null}

      {status ? <p role="status" className={status.startsWith("Thanks") ? "success" : "error"}>{status}</p> : null}
    </section>
  );
}
