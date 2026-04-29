import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RatingScale } from "../src/client/src/components/RatingScale";
import { AdminPage } from "../src/client/src/pages/AdminPage";
import { SurveyPage } from "../src/client/src/pages/SurveyPage";
import { colorForAverage } from "../src/client/src/lib/colorScale";
import { joinAggregates } from "../src/client/src/lib/plzJoin";
import { isValidPostalCode } from "../src/client/src/lib/validation";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("frontend survey controls", () => {
  it("renders and selects a dynamic rating scale", () => {
    const onChange = vi.fn();
    render(<RatingScale min={-5} max={5} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "+5" }));
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
          max_rating: 3
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: "response-1" })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<SurveyPage />);
    expect(await screen.findByText("Rate it")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "+3" }));
    fireEvent.change(screen.getByLabelText(/postal code/i), { target: { value: "10115" } });
    fireEvent.click(screen.getByRole("button", { name: /submit response/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Thanks"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ survey_id: "default", postal_code: "10115", rating: 3 })
      })
    );
  });

  it("clears and fills survey data from the admin page", async () => {
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
          is_active: true
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ totalResponses: 0, postalCodeCount: 0 })
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

    fireEvent.click(screen.getByRole("button", { name: /clear database/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Database cleared."));
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/clear-results",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({})
      })
    );
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
      { postal_code: "10115", count: 12, average: 1.8, sum: 22 }
    ]);

    expect(joined.features[0].properties).toMatchObject({ postal_code: "10115", count: 12, average: 1.8 });
    expect(joined.features[1].properties).toMatchObject({ postal_code: "80331", count: 0, average: null });
  });

  it("adapts color scale outside the default -3 to +3 range", () => {
    expect(colorForAverage(-5, -5, 5)).toBe("rgb(37, 99, 235)");
    expect(colorForAverage(5, -5, 5)).toBe("rgb(220, 38, 38)");
    expect(colorForAverage(null, -5, 5)).toBe("#e5e7eb");
    expect(colorForAverage(1, -5, 5, true)).toBe("#9ca3af");
  });
});
