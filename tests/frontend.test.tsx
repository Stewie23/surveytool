import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RatingScale } from "../src/client/src/components/RatingScale";
import { AdminPage } from "../src/client/src/pages/AdminPage";
import { SurveyPage } from "../src/client/src/pages/SurveyPage";
import { colorForAverage } from "../src/client/src/lib/colorScale";
import { aggregateToPlzLevel, joinAggregates, plzLevelForZoom } from "../src/client/src/lib/plzJoin";
import { isValidPostalCode } from "../src/client/src/lib/validation";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("frontend survey controls", () => {
  it("renders and selects a dynamic rating scale", () => {
    const onChange = vi.fn();
    render(<RatingScale min={-5} max={5} labels={{ "5": "Strongly agree" }} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "+5 Strongly agree" }));
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it("validates 5-digit German postal codes", () => {
    expect(isValidPostalCode("10115")).toBe(true);
    expect(isValidPostalCode("1011")).toBe(false);
    expect(isValidPostalCode("ABCDE")).toBe(false);
  });

  it("submits a successful survey response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: "default",
          title: "Test",
          question_text: "Rate it",
          min_rating: -3,
          max_rating: 3,
          pages: [
            {
              id: "page-1",
              title: "Basics",
              questions: [
                { id: "q-1", text: "Rate it", min_rating: -3, max_rating: 3 },
                { id: "q-2", text: "Rate more", min_rating: -2, max_rating: 2, rating_labels: { "2": "Agree" } }
              ]
            },
            {
              id: "page-2",
              title: "Follow up",
              questions: [
                { id: "q-3", text: "Final rating", min_rating: 1, max_rating: 5 }
              ]
            }
          ],
          terms_enabled: true,
          terms_text: "Sample terms"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: "response-1" })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<SurveyPage />);
    expect(await screen.findByText("Rate it")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/postal code/i)).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "+3" }));
    fireEvent.click(screen.getByRole("radio", { name: "+2 Agree" }));
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: "10115" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("Final rating")).toBeInTheDocument();
    expect(screen.queryByLabelText(/postal code/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "+5" }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("Sample terms")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/i accept the terms/i));
    fireEvent.click(screen.getByRole("button", { name: /submit response/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Thanks"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          survey_id: "default",
          postal_code: "10115",
          rating: 3,
          answers: [
            { question_id: "q-1", rating: 3 },
            { question_id: "q-2", rating: 2 },
            { question_id: "q-3", rating: 5 }
          ],
          terms_accepted: true
        })
      })
    );
  });

  it("edits pages, terms, and survey data from the admin page", async () => {
    localStorage.setItem("admin-token", "admin-token");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: "default",
          title: "Test",
          question_text: "Rate it",
          min_rating: -3,
          max_rating: 3,
          rating_labels: { "3": "Strongly agree" },
          pages: [
            {
              id: "page-1",
              title: "Page 1",
              questions: [
                { id: "q-1", text: "Rate it", min_rating: -3, max_rating: 3, rating_labels: { "3": "Strongly agree" } }
              ]
            }
          ],
          terms_enabled: false,
          terms_text: "",
          is_active: true
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ totalResponses: 0, postalCodeCount: 0 })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: "default",
          title: "Test",
          question_text: "Rate it",
          min_rating: -3,
          max_rating: 3,
          rating_labels: { "3": "Agree strongly" },
          pages: [
            {
              id: "page-1",
              title: "Intro",
              questions: [
                { id: "q-1", text: "Rate it", min_rating: -3, max_rating: 3, rating_labels: { "3": "Agree strongly" } },
                { id: "question-new", text: "New rating question", min_rating: -3, max_rating: 3, rating_labels: {} }
              ]
            },
            {
              id: "page-new",
              title: "Page 2",
              questions: [
                { id: "q-new", text: "New rating question", min_rating: -3, max_rating: 3, rating_labels: {} }
              ]
            }
          ],
          terms_enabled: true,
          terms_text: "Terms go here",
          is_active: true
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ totalResponses: 12, postalCodeCount: 3 })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ totalResponses: 0, postalCodeCount: 0 })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Survey settings")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/page title/i), { target: { value: "Intro" } });
    fireEvent.change(screen.getByPlaceholderText("Strongly agree"), { target: { value: "Agree strongly" } });
    fireEvent.click(screen.getByRole("button", { name: /add question/i }));
    fireEvent.click(screen.getByRole("button", { name: /add page/i }));
    fireEvent.click(screen.getByLabelText(/enable terms/i));
    fireEvent.change(screen.getByLabelText(/terms text/i), { target: { value: "Terms go here" } });
    fireEvent.click(screen.getByRole("button", { name: /save survey/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Survey saved."));
    const saveCall = fetchMock.mock.calls.find(([path]) => path === "/api/admin/survey");
    const saveBody = JSON.parse(saveCall?.[1]?.body as string);
    expect(saveBody).toMatchObject({
      title: "Test",
      question_text: "Rate it",
      min_rating: -3,
      max_rating: 3,
      rating_labels: { "3": "Agree strongly" },
      terms_enabled: true,
      terms_text: "Terms go here",
      is_active: true
    });
    expect(saveBody.pages).toHaveLength(2);
    expect(saveBody.pages[0]).toMatchObject({
      title: "Intro",
      questions: [
        expect.objectContaining({ text: "Rate it", rating_labels: { "3": "Agree strongly" } }),
        expect.objectContaining({ text: "New rating question" })
      ]
    });

    fireEvent.change(screen.getByLabelText(/random responses/i), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /fill with random data/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Added 12 random responses."));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/random-responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ count: 12 })
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /clear responses/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Responses cleared."));
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/clear-results",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({})
      })
    );
  });

  it("saves an added admin question without requiring another editor action", async () => {
    localStorage.setItem("admin-token", "admin-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: "default",
          title: "Test",
          question_text: "Rate it",
          min_rating: -3,
          max_rating: 3,
          rating_labels: {},
          pages: [{
            id: "page-1",
            title: "Page 1",
            questions: [{ id: "q-1", text: "Rate it", min_rating: -3, max_rating: 3, rating_labels: {} }]
          }],
          terms_enabled: false,
          terms_text: "",
          is_active: true
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ totalResponses: 0, postalCodeCount: 0 })
      })
      .mockImplementationOnce(async (_path, options) => ({
        ok: true,
        text: async () => options?.body as string
      }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Survey settings")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add question/i }));
    fireEvent.click(screen.getByRole("button", { name: /save survey/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Survey saved."));
    const saveCall = fetchMock.mock.calls.find(([path]) => path === "/api/admin/survey");
    const saveBody = JSON.parse(saveCall?.[1]?.body as string);
    expect(saveBody.pages[0].questions).toHaveLength(2);
    expect(saveBody.pages[0].questions[1]).toMatchObject({ text: "New rating question" });
  });

  it("keeps local questions visible when a stale save response drops pages", async () => {
    localStorage.setItem("admin-token", "admin-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: "default",
          title: "Test",
          question_text: "Rate it",
          min_rating: -3,
          max_rating: 3,
          rating_labels: {},
          pages: [{
            id: "page-1",
            title: "Page 1",
            questions: [{ id: "q-1", text: "Rate it", min_rating: -3, max_rating: 3, rating_labels: {} }]
          }],
          terms_enabled: false,
          terms_text: "",
          is_active: true
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ totalResponses: 0, postalCodeCount: 0 })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: "active",
          title: "Test",
          question_text: "Rate it",
          min_rating: -3,
          max_rating: 3,
          rating_labels: {},
          is_active: true
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Survey settings")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add question/i }));
    fireEvent.click(screen.getByRole("button", { name: /save survey/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Frontend/backend mismatch"));
    expect(screen.getByText("Question 2")).toBeInTheDocument();
  });
});

describe("frontend map helpers", () => {
  it("joins aggregate rows onto PLZ features by postal_code", () => {
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
          properties: { postal_code: "10115" }
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [11.6, 48.1] },
          properties: { plz: "80331" }
        }
      ]
    };

    const joined = joinAggregates(collection, [
      { question_id: "q-1", postal_code: "10115", count: 12, average: 1.8, sum: 22 }
    ]);

    expect(joined.features[0].properties).toMatchObject({ postal_code: "10115", count: 12, average: 1.8 });
    expect(joined.features[1].properties).toMatchObject({ postal_code: "80331", count: 0, average: null });
  });

  it("aggregates 5-digit rows to PLZ prefixes from sum and count", () => {
    const aggregates = aggregateToPlzLevel([
      { question_id: "q-1", postal_code: "10115", count: 2, average: 5, sum: 10 },
      { question_id: "q-1", postal_code: "10117", count: 8, average: 1, sum: 8, hidden: true },
      { question_id: "q-1", postal_code: "80331", count: 4, average: -1, sum: -4 }
    ], 2);

    expect(aggregates).toEqual([
      { question_id: "q-1", postal_code: "10", count: 10, average: 1.8, sum: 18, hidden: false },
      { question_id: "q-1", postal_code: "80", count: 4, average: -1, sum: -4, hidden: false }
    ]);
  });

  it("keeps exact PLZ5 hidden rows unchanged", () => {
    const aggregates = aggregateToPlzLevel([
      { question_id: "q-1", postal_code: "10117", count: 1, average: null, sum: 5, hidden: true }
    ], 5);

    expect(aggregates).toEqual([
      { question_id: "q-1", postal_code: "10117", count: 1, average: null, sum: 5, hidden: true }
    ]);
  });

  it("joins aggregate rows onto PLZ prefix features", () => {
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
          properties: { plz: "10" }
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [11.6, 48.1] },
          properties: { postal_code: "80331" }
        }
      ]
    };

    const joined = joinAggregates(collection, [
      { question_id: "q-1", postal_code: "10115", count: 2, average: 3, sum: 6 },
      { question_id: "q-1", postal_code: "10117", count: 3, average: 1, sum: 3 },
      { question_id: "q-1", postal_code: "80331", count: 4, average: -1, sum: -4 }
    ], 2);

    expect(joined.features[0].properties).toMatchObject({ postal_code: "10", count: 5, average: 1.8, sum: 9 });
    expect(joined.features[1].properties).toMatchObject({ postal_code: "80", count: 4, average: -1, sum: -4 });
  });

  it("selects coarser PLZ levels for lower zooms", () => {
    expect(plzLevelForZoom(4.99)).toBe(1);
    expect(plzLevelForZoom(5)).toBe(2);
    expect(plzLevelForZoom(6.5)).toBe(3);
    expect(plzLevelForZoom(8)).toBe(4);
    expect(plzLevelForZoom(9.5)).toBe(5);
  });

  it("adapts color scale outside the default -3 to +3 range", () => {
    expect(colorForAverage(-5, -5, 5)).toBe("rgb(37, 99, 235)");
    expect(colorForAverage(5, -5, 5)).toBe("rgb(220, 38, 38)");
    expect(colorForAverage(null, -5, 5)).toBe("#e5e7eb");
    expect(colorForAverage(1, -5, 5, true)).toBe("#9ca3af");
  });
});
