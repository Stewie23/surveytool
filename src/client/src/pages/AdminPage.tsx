import { FormEvent, useEffect, useMemo, useState } from "react";
import { RatingScale } from "../components/RatingScale";
import { apiGet, apiPost, getActiveSurvey, type PagedSurvey, type SurveyPageConfig, type SurveyQuestion } from "../lib/api";
import { ratingValues } from "../lib/validation";

type Stats = {
  totalResponses: number;
  postalCodeCount: number;
};

type AdminSession = {
  authenticated: boolean;
};

function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function createQuestion(): SurveyQuestion {
  return {
    id: newId("question"),
    text: "New rating question",
    min_rating: -3,
    max_rating: 3,
    rating_labels: {}
  };
}

function createPage(title = "Page 1"): SurveyPageConfig {
  return {
    id: newId("page"),
    title,
    questions: [createQuestion()]
  };
}

function normalizeSurvey(survey: PagedSurvey): PagedSurvey {
  const pages = survey.pages?.length
    ? survey.pages.map((page, pageIndex) => ({
      ...page,
      id: page.id || newId("page"),
      title: page.title || `Page ${pageIndex + 1}`,
      questions: page.questions?.length
        ? page.questions.map((question) => ({
          ...question,
          id: question.id || newId("question"),
          text: question.text || "Untitled question",
          min_rating: question.min_rating,
          max_rating: question.max_rating,
          rating_labels: question.rating_labels ?? {}
        }))
        : [createQuestion()]
    }))
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
    }];

  return {
    ...survey,
    pages,
    terms_enabled: survey.terms_enabled ?? false,
    terms_text: survey.terms_text ?? "",
    use_aggregated_shapes: survey.use_aggregated_shapes ?? false
  };
}

function replacePage(survey: PagedSurvey, pageId: string, update: (page: SurveyPageConfig) => SurveyPageConfig): PagedSurvey {
  return {
    ...survey,
    pages: (survey.pages ?? []).map((page) => page.id === pageId ? update(page) : page)
  };
}

function replaceQuestion(
  survey: PagedSurvey,
  pageId: string,
  questionId: string,
  update: (question: SurveyQuestion) => SurveyQuestion
): PagedSurvey {
  return replacePage(survey, pageId, (page) => ({
    ...page,
    questions: page.questions.map((question) => question.id === questionId ? update(question) : question)
  }));
}

function summarizePages(pages: SurveyPageConfig[] | undefined) {
  return (pages ?? []).map((page, pageIndex) => ({
    pageIndex,
    pageId: page.id,
    pageTitle: page.title,
    questionCount: page.questions.length,
    questions: page.questions.map((question, questionIndex) => ({
      questionIndex,
      id: question.id,
      text: question.text,
      min_rating: question.min_rating,
      max_rating: question.max_rating,
      labelCount: Object.keys(question.rating_labels ?? {}).length
    }))
  }));
}

function countQuestions(pages: SurveyPageConfig[] | undefined) {
  return pages?.reduce((count, page) => count + page.questions.length, 0) ?? 0;
}

export function AdminPage() {
  const [authStatus, setAuthStatus] = useState<"checking" | "login" | "authenticated">("checking");
  const [password, setPassword] = useState("");
  const [survey, setSurvey] = useState<PagedSurvey | null>(null);
  const [selectedPageId, setSelectedPageId] = useState("");
  const [previewRatings, setPreviewRatings] = useState<Record<string, number | null>>({});
  const [stats, setStats] = useState<Stats>({ totalResponses: 0, postalCodeCount: 0 });
  const [randomCount, setRandomCount] = useState(100);
  const [status, setStatus] = useState("");
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    apiGet<AdminSession>("/api/admin/session")
      .then((session) => {
        if (session.authenticated) {
          setAuthStatus("authenticated");
        } else {
          setAuthStatus("login");
        }
      })
      .catch(() => setAuthStatus("login"));
  }, []);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    loadAdminData().catch((error) => setStatus(error instanceof Error ? error.message : "Loading admin failed."));
  }, [authStatus]);

  const selectedPage = useMemo(
    () => survey?.pages?.find((page) => page.id === selectedPageId) ?? survey?.pages?.[0],
    [selectedPageId, survey]
  );

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!survey) return;
    const firstQuestion = survey.pages?.[0]?.questions[0];
    if (!firstQuestion) {
      setStatus("Add at least one page with one question.");
      return;
    }

    setStatus("");
    try {
      const payload = {
        title: survey.title,
        question_text: firstQuestion.text,
        min_rating: firstQuestion.min_rating,
        max_rating: firstQuestion.max_rating,
        rating_labels: firstQuestion.rating_labels ?? {},
        pages: survey.pages,
        terms_enabled: survey.terms_enabled ?? false,
        terms_text: survey.terms_text ?? "",
        use_aggregated_shapes: survey.use_aggregated_shapes ?? false,
        is_active: survey.is_active ?? true
      };

      console.groupCollapsed("[Survey Admin] Saving survey");
      console.log("Payload summary", {
        title: payload.title,
        is_active: payload.is_active,
        terms_enabled: payload.terms_enabled,
        pageCount: payload.pages?.length ?? 0,
        questionCount: countQuestions(payload.pages),
        pages: summarizePages(payload.pages)
      });
      console.log("Payload", payload);
      console.groupEnd();

      const saved = await apiPost<PagedSurvey>("/api/admin/survey", payload);
      const normalized = normalizeSurvey(saved);
      console.groupCollapsed("[Survey Admin] Survey saved");
      console.log("Response summary", {
        id: normalized.id,
        title: normalized.title,
        pageCount: normalized.pages?.length ?? 0,
        questionCount: countQuestions(normalized.pages),
        pages: summarizePages(normalized.pages)
      });
      console.log("Response", saved);
      console.groupEnd();
      if (countQuestions(normalized.pages) < countQuestions(payload.pages)) {
        throw new Error("Frontend/backend mismatch: the save response dropped questions. Restart all dev processes and save again.");
      }
      setSurvey(normalized);
      setSelectedPageId((current) => normalized.pages?.some((page) => page.id === current) ? current : normalized.pages?.[0]?.id ?? "");
      setStatus("Survey saved.");
    } catch (error) {
      console.error("[Survey Admin] Save failed", error, {
        title: survey.title,
        pageCount: survey.pages?.length ?? 0,
        questionCount: survey.pages?.reduce((count, page) => count + page.questions.length, 0) ?? 0,
        pages: summarizePages(survey.pages)
      });
      setStatus(error instanceof Error ? error.message : "Save failed.");
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setStatus("");
    setIsWorking(true);
    try {
      await apiPost<AdminSession>("/api/admin/login", { password });
      setPassword("");
      setAuthStatus("authenticated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setIsWorking(false);
    }
  }

  async function logout() {
    setStatus("");
    setIsWorking(true);
    try {
      await apiPost<AdminSession>("/api/admin/logout", {});
      setSurvey(null);
      setSelectedPageId("");
      setStats({ totalResponses: 0, postalCodeCount: 0 });
      setAuthStatus("login");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Logout failed.");
    } finally {
      setIsWorking(false);
    }
  }

  async function loadAdminData() {
    const loaded = await getActiveSurvey();
    const normalized = normalizeSurvey(loaded as PagedSurvey);
    setSurvey(normalized);
    setSelectedPageId(normalized.pages?.[0]?.id ?? "");
    if (!(loaded as PagedSurvey).pages?.length) {
      setStatus("Frontend/backend mismatch: the backend returned the old single-question survey shape. Restart all dev processes before editing multiple questions.");
    }
    await refreshStats();
  }

  async function refreshStats() {
    const latestStats = await apiGet<Stats>("/api/admin/stats");
    setStats(latestStats);
  }

  function exportCsv() {
    window.open("/api/admin/export.csv", "_blank");
  }

  async function clearResults() {
    if (!window.confirm("Clear all stored responses and map aggregates? This cannot be undone.")) return;

    setStatus("");
    setIsWorking(true);
    try {
      const latestStats = await apiPost<Stats>("/api/admin/clear-results", {});
      setStats(latestStats);
      setStatus("Responses cleared.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Clearing failed.");
    } finally {
      setIsWorking(false);
    }
  }

  async function fillRandomData() {
    setStatus("");
    setIsWorking(true);
    try {
      const latestStats = await apiPost<Stats>("/api/admin/random-responses", { count: randomCount });
      setStats(latestStats);
      setStatus(`Added ${randomCount} random responses.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Random data generation failed.");
    } finally {
      setIsWorking(false);
    }
  }

  function addPage() {
    if (!survey) return;
    const page = createPage(`Page ${(survey.pages?.length ?? 0) + 1}`);
    setSurvey((current) => current ? { ...current, pages: [...(current.pages ?? []), page] } : current);
    setSelectedPageId(page.id);
  }

  function removePage(pageId: string) {
    if (!survey || (survey.pages?.length ?? 0) <= 1) return;
    const pages = (survey.pages ?? []).filter((page) => page.id !== pageId);
    setSurvey((current) => current ? { ...current, pages: (current.pages ?? []).filter((page) => page.id !== pageId) } : current);
    setSelectedPageId(pages[0]?.id ?? "");
  }

  function movePage(pageId: string, direction: -1 | 1) {
    if (!survey?.pages) return;
    setSurvey((current) => {
      if (!current?.pages) return current;
      const pages = [...current.pages];
      const index = pages.findIndex((page) => page.id === pageId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= pages.length) return current;
      [pages[index], pages[nextIndex]] = [pages[nextIndex], pages[index]];
      return { ...current, pages };
    });
  }

  function addQuestion(pageId: string) {
    if (!survey) return;
    setSurvey((current) => current ? replacePage(current, pageId, (page) => ({
      ...page,
      questions: [...page.questions, createQuestion()]
    })) : current);
  }

  function removeQuestion(pageId: string, questionId: string) {
    if (!survey) return;
    setSurvey((current) => current ? replacePage(current, pageId, (page) => {
      if (page.questions.length <= 1) return page;
      return { ...page, questions: page.questions.filter((question) => question.id !== questionId) };
    }) : current);
  }

  function moveQuestion(pageId: string, questionId: string, direction: -1 | 1) {
    if (!survey) return;
    setSurvey((current) => current ? replacePage(current, pageId, (page) => {
      const questions = [...page.questions];
      const index = questions.findIndex((question) => question.id === questionId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= questions.length) return page;
      [questions[index], questions[nextIndex]] = [questions[nextIndex], questions[index]];
      return { ...page, questions };
    }) : current);
  }

  if (authStatus === "checking") {
    return <section className="panel">Loading admin...</section>;
  }

  if (authStatus === "login") {
    return (
      <section className="panel admin-panel">
        <p className="eyebrow">Admin</p>
        <h1>Admin login</h1>
        <form onSubmit={login} className="admin-grid">
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button className="primary" type="submit" disabled={isWorking || !password}>
            Log in
          </button>
        </form>
        {status ? <p role="status">{status}</p> : null}
      </section>
    );
  }

  if (!survey) {
    return <section className="panel">Loading admin...</section>;
  }

  return (
    <section className="panel admin-panel">
      <p className="eyebrow">Admin</p>
      <h1>Survey settings</h1>
      <form onSubmit={save} className="admin-grid">
        <label className="field">
          <span>Title</span>
          <input value={survey.title} onChange={(event) => {
            const title = event.target.value;
            setSurvey((current) => current ? { ...current, title } : current);
          }} />
        </label>
        <label className="check">
          <input type="checkbox" checked={survey.is_active ?? true} onChange={(event) => {
            const isActive = event.target.checked;
            setSurvey((current) => current ? { ...current, is_active: isActive } : current);
          }} />
          Active
        </label>
        <label className="check">
          <input type="checkbox" checked={survey.use_aggregated_shapes ?? false} onChange={(event) => {
            const useAggregatedShapes = event.target.checked;
            setSurvey((current) => current ? { ...current, use_aggregated_shapes: useAggregatedShapes } : current);
          }} />
          Use aggregated shapes
        </label>

        <div className="wide page-builder">
          <div className="page-tabs" aria-label="Survey pages">
            {(survey.pages ?? []).map((page, index) => (
              <button
                key={page.id}
                type="button"
                className={page.id === selectedPage?.id ? "active" : ""}
                onClick={() => setSelectedPageId(page.id)}
              >
                {index + 1}. {page.title}
              </button>
            ))}
            <button type="button" onClick={addPage}>Add page</button>
          </div>

          {selectedPage ? (
            <div className="page-editor">
              <div className="page-editor__header">
                <label className="field">
                  <span>Page title</span>
                  <input
                    value={selectedPage.title}
                    onChange={(event) => {
                      const title = event.target.value;
                      setSurvey((current) => current ? replacePage(current, selectedPage.id, (page) => ({ ...page, title })) : current);
                    }}
                  />
                </label>
                <div className="admin-actions">
                  <button type="button" onClick={() => movePage(selectedPage.id, -1)}>Move up</button>
                  <button type="button" onClick={() => movePage(selectedPage.id, 1)}>Move down</button>
                  <button type="button" className="danger" onClick={() => removePage(selectedPage.id)} disabled={(survey.pages?.length ?? 0) <= 1}>
                    Remove page
                  </button>
                </div>
              </div>

              <div className="question-list">
                {selectedPage.questions.map((question, questionIndex) => (
                  <section className="question-editor" key={question.id}>
                    <div className="question-editor__header">
                      <h2>Question {questionIndex + 1}</h2>
                      <div className="admin-actions">
                        <button type="button" onClick={() => moveQuestion(selectedPage.id, question.id, -1)}>Move up</button>
                        <button type="button" onClick={() => moveQuestion(selectedPage.id, question.id, 1)}>Move down</button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => removeQuestion(selectedPage.id, question.id)}
                          disabled={selectedPage.questions.length <= 1}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <label className="field wide">
                      <span>Question text</span>
                      <textarea
                        value={question.text}
                        onChange={(event) => {
                          const text = event.target.value;
                          setSurvey((current) => current ? replaceQuestion(current, selectedPage.id, question.id, (item) => ({ ...item, text })) : current);
                        }}
                      />
                    </label>
                    <div className="question-editor__range">
                      <label className="field">
                        <span>Minimum rating</span>
                        <input
                          type="number"
                          value={question.min_rating}
                          onChange={(event) => {
                            const minRating = Number(event.target.value);
                            setSurvey((current) => current ? replaceQuestion(current, selectedPage.id, question.id, (item) => ({ ...item, min_rating: minRating })) : current);
                          }}
                        />
                      </label>
                      <label className="field">
                        <span>Maximum rating</span>
                        <input
                          type="number"
                          value={question.max_rating}
                          onChange={(event) => {
                            const maxRating = Number(event.target.value);
                            setSurvey((current) => current ? replaceQuestion(current, selectedPage.id, question.id, (item) => ({ ...item, max_rating: maxRating })) : current);
                          }}
                        />
                      </label>
                    </div>
                    <div>
                      <span className="label">Rating labels</span>
                      <div className="rating-labels">
                        {ratingValues(question.min_rating, question.max_rating).map((rating) => {
                          const ratingLabel = rating > 0 ? `+${rating}` : String(rating);
                          return (
                            <label className="field rating-labels__row" key={rating}>
                              <span>{ratingLabel}</span>
                              <input
                                value={question.rating_labels?.[String(rating)] ?? ""}
                                placeholder={rating === question.min_rating ? "Strongly disagree" : rating === question.max_rating ? "Strongly agree" : "Optional label"}
                                onChange={(event) => {
                                  const label = event.target.value;
                                  setSurvey((current) => current ? replaceQuestion(current, selectedPage.id, question.id, (item) => ({
                                    ...item,
                                    rating_labels: {
                                      ...(item.rating_labels ?? {}),
                                      [String(rating)]: label
                                    }
                                  })) : current);
                                }}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <span className="label">Preview</span>
                      <RatingScale
                        min={question.min_rating}
                        max={question.max_rating}
                        labels={question.rating_labels}
                        value={previewRatings[question.id] ?? null}
                        onChange={(value) => setPreviewRatings({ ...previewRatings, [question.id]: value })}
                      />
                    </div>
                  </section>
                ))}
              </div>
              <button type="button" onClick={() => addQuestion(selectedPage.id)}>Add question</button>
            </div>
          ) : null}
        </div>

        <div className="wide terms-editor">
          <label className="check">
            <input
              type="checkbox"
              checked={survey.terms_enabled ?? false}
              onChange={(event) => {
                const termsEnabled = event.target.checked;
                setSurvey((current) => current ? { ...current, terms_enabled: termsEnabled } : current);
              }}
            />
            Enable terms
          </label>
          <label className="field">
            <span>Terms text</span>
            <textarea
              value={survey.terms_text ?? ""}
              onChange={(event) => {
                const termsText = event.target.value;
                setSurvey((current) => current ? { ...current, terms_text: termsText } : current);
              }}
              disabled={!survey.terms_enabled}
            />
          </label>
        </div>

        <button className="primary" type="submit">Save survey</button>
        <button type="button" onClick={exportCsv}>Export CSV</button>
        <button type="button" onClick={logout} disabled={isWorking}>Log out</button>
      </form>
      <div className="admin-tools" aria-label="Database tools">
        <h2>Database tools</h2>
        <label className="field">
          <span>Random responses</span>
          <input
            type="number"
            min="1"
            max="10000"
            value={randomCount}
            onChange={(event) => setRandomCount(Number(event.target.value))}
          />
        </label>
        <div className="admin-actions">
          <button type="button" onClick={fillRandomData} disabled={isWorking || randomCount < 1 || randomCount > 10000}>
            Fill with random data
          </button>
          <button className="danger" type="button" onClick={clearResults} disabled={isWorking}>
            Clear responses
          </button>
        </div>
      </div>
      <div className="stats">
        <span>{stats.totalResponses} responses</span>
        <span>{stats.postalCodeCount} PLZ areas</span>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
