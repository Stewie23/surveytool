import { FormEvent, useEffect, useState } from "react";
import type { Survey } from "../../../shared/types";
import { RatingScale } from "../components/RatingScale";
import { apiGet, apiPost, getActiveSurvey } from "../lib/api";

type Stats = {
  totalResponses: number;
  postalCodeCount: number;
};

export function AdminPage() {
  const [token, setToken] = useState(() => localStorage.getItem("admin-token") ?? "");
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [stats, setStats] = useState<Stats>({ totalResponses: 0, postalCodeCount: 0 });
  const [previewRating, setPreviewRating] = useState<number | null>(null);
  const [randomCount, setRandomCount] = useState(100);
  const [status, setStatus] = useState("");
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    getActiveSurvey().then(setSurvey).catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!token) return;
    localStorage.setItem("admin-token", token);
    refreshStats().catch(() => undefined);
  }, [token]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!survey) return;
    setStatus("");
    try {
      const saved = await apiPost<Survey>("/api/admin/survey", {
        title: survey.title,
        question_text: survey.question_text,
        min_rating: survey.min_rating,
        max_rating: survey.max_rating,
        is_active: survey.is_active ?? true
      }, token);
      setSurvey(saved);
      setStatus("Survey saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed.");
    }
  }

  async function refreshStats() {
    if (!token) return;
    const latestStats = await apiGet<Stats>("/api/admin/stats", token);
    setStats(latestStats);
  }

  function exportCsv() {
    if (!token) return;
    window.open(`/api/admin/export.csv?token=${encodeURIComponent(token)}`, "_blank");
  }

  async function clearResults() {
    if (!window.confirm("Clear all stored responses and map aggregates? This cannot be undone.")) {
      return;
    }

    setStatus("");
    setIsWorking(true);
    try {
      const latestStats = await apiPost<Stats>("/api/admin/clear-results", {}, token);
      setStats(latestStats);
      setStatus("Database cleared.");
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
      const latestStats = await apiPost<Stats>("/api/admin/random-responses", { count: randomCount }, token);
      setStats(latestStats);
      setStatus(`Added ${randomCount} random responses.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Random data generation failed.");
    } finally {
      setIsWorking(false);
    }
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
          <span>Admin token</span>
          <input value={token} onChange={(event) => setToken(event.target.value)} />
        </label>
        <label className="field">
          <span>Title</span>
          <input value={survey.title} onChange={(event) => setSurvey({ ...survey, title: event.target.value })} />
        </label>
        <label className="field wide">
          <span>Question</span>
          <textarea value={survey.question_text} onChange={(event) => setSurvey({ ...survey, question_text: event.target.value })} />
        </label>
        <label className="field">
          <span>Minimum rating</span>
          <input type="number" value={survey.min_rating} onChange={(event) => setSurvey({ ...survey, min_rating: Number(event.target.value) })} />
        </label>
        <label className="field">
          <span>Maximum rating</span>
          <input type="number" value={survey.max_rating} onChange={(event) => setSurvey({ ...survey, max_rating: Number(event.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={survey.is_active ?? true} onChange={(event) => setSurvey({ ...survey, is_active: event.target.checked })} />
          Active
        </label>
        <div className="wide">
          <span className="label">Preview</span>
          <RatingScale min={survey.min_rating} max={survey.max_rating} value={previewRating} onChange={setPreviewRating} />
        </div>
        <button className="primary" type="submit">Save survey</button>
        <button type="button" onClick={exportCsv}>Export CSV</button>
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
          <button type="button" onClick={fillRandomData} disabled={isWorking || !token || randomCount < 1 || randomCount > 10000}>
            Fill with random data
          </button>
          <button className="danger" type="button" onClick={clearResults} disabled={isWorking || !token}>
            Clear database
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
