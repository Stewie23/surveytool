import { useMemo, useState } from "react";
import { AdminPage } from "./pages/AdminPage";
import { MapPage } from "./pages/MapPage";
import { SurveyPage } from "./pages/SurveyPage";

type Page = "survey" | "map" | "admin";

export function App() {
  const [page, setPage] = useState<Page>(() => (location.hash.replace("#", "") as Page) || "survey");
  const current = useMemo(() => {
    if (page === "map") return <MapPage />;
    if (page === "admin") return <AdminPage />;
    return <SurveyPage />;
  }, [page]);

  function navigate(next: Page) {
    setPage(next);
    history.replaceState(null, "", `#${next}`);
  }

  return (
    <main className="app-shell">
      <nav className="top-nav" aria-label="Main navigation">
        <strong>PLZ Survey</strong>
        <div>
          <button className={page === "survey" ? "active" : ""} onClick={() => navigate("survey")}>Survey</button>
          <button className={page === "map" ? "active" : ""} onClick={() => navigate("map")}>Map</button>
          <button className={page === "admin" ? "active" : ""} onClick={() => navigate("admin")}>Admin</button>
        </div>
      </nav>
      {current}
    </main>
  );
}
