import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { RatingScale } from "../src/client/src/components/RatingScale";
import { AdminPage } from "../src/client/src/pages/AdminPage";
import { MapPage } from "../src/client/src/pages/MapPage";
import { SurveyPage } from "../src/client/src/pages/SurveyPage";
import { colorForAverage, parsePaletteText } from "../src/client/src/lib/colorScale";
import { aggregateToPlzLevel, joinAggregates, nearestEnabledPlzLevel, plzLevelForZoom } from "../src/client/src/lib/plzJoin";
import { isValidPostalCode } from "../src/client/src/lib/validation";

vi.mock("../src/client/src/components/GermanyPlzMap", () => ({
  GermanyPlzMap: ({ aggregates }: { aggregates: Array<{ count: number }> }) => (
    <div data-testid="mock-map">{aggregates.reduce((sum, item) => sum + item.count, 0)}</div>
  )
}));

vi.mock("qrcode", () => ({
  default: {
    toCanvas: vi.fn(async () => undefined),
    toDataURL: vi.fn(async () => "data:image/png;base64,cXI=")
  }
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

function textResponse(text: string) {
  return {
    ok: true,
    text: async () => text
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(event: string, handler: (event: MessageEvent<string>) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }

  close() {
    // jsdom test double: no transport to close.
  }

  emit(event: string, payload: unknown) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler({ data: JSON.stringify(payload) } as MessageEvent<string>);
    }
  }
}

function mapFetchMock(results: Array<unknown>, useAggregatedShapes = false, mapLodLevels?: number[]) {
  let resultIndex = 0;
  const plzData = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [13.4, 52.5] },
      properties: { postal_code: "10115" }
    }]
  };

  return vi.fn(async (path: string) => {
    if (path === "/api/survey/active") {
      return jsonResponse({
        id: "active",
        title: "Map survey",
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
        use_aggregated_shapes: useAggregatedShapes,
        map_lod_levels: mapLodLevels,
        map_palette: "batlow",
        is_active: true
      });
    }
    if (path === "/data/germany-plz.topojson.json") return jsonResponse(plzData);
    if (path === "/data/germany-plz-1.topojson.json") return jsonResponse(plzData);
    if (path === "/data/germany-plz-2.topojson.json") return jsonResponse(plzData);
    if (path === "/data/germany-plz-3.topojson.json") return jsonResponse(plzData);
    if (path === "/data/germany-plz-4.topojson.json") return jsonResponse(plzData);
    if (path === "/data/gradients/batlow.txt") return textResponse("0 0 0\n1 1 1");
    if (path === "/api/results/active") {
      const result = results[Math.min(resultIndex, results.length - 1)];
      resultIndex += 1;
      return jsonResponse(result);
    }
    throw new Error(`Unexpected fetch ${path}`);
  });
}

function adminFetchMock(responses: Array<unknown | ((path: string, options?: RequestInit) => unknown)>) {
  const queue = [...responses];
  return vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith("/data/gradients/")) {
      return textResponse("0 0 0\n1 1 1");
    }
    const next = queue.shift();
    if (typeof next === "function") return next(path, options);
    return next;
  });
}

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
          thank_you_text: "Thank **you**.\n\nMore soon.",
          terms_enabled: true,
          terms_text: "Sample terms"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ id: "response-1" })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ saved: true })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<SurveyPage />);
    expect(await screen.findByText("Rate it")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/postleitzahl/i)).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "+3" }));
    fireEvent.click(screen.getByRole("radio", { name: "+2 Agree" }));
    fireEvent.change(screen.getByLabelText(/postleitzahl/i), { target: { value: "10115" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("Final rating")).toBeInTheDocument();
    expect(screen.queryByLabelText(/postleitzahl/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "+5" }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("Sample terms")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/i accept the terms/i));
    fireEvent.click(screen.getByRole("button", { name: /submit response/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Thank you."));
    expect(screen.getByText("More soon.")).toBeInTheDocument();
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

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /save contact/i }));
    await waitFor(() => expect(screen.getByText("Thanks, your contact details were saved.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/newsletter-contacts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Ada Lovelace",
          email: "ada@example.com"
        })
      })
    );
  });

  it("shows a start page before survey questions", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        id: "default",
        title: "Test",
        question_text: "Rate it",
        min_rating: -3,
        max_rating: 3,
        start_text: "Welcome **cluster**.\n\nSecond paragraph.",
        start_logo_data_url: "data:image/png;base64,aGVsbG8=",
        pages: [{
          id: "page-1",
          title: "Basics",
          questions: [{ id: "q-1", text: "Rate it", min_rating: -3, max_rating: 3 }]
        }],
        terms_enabled: false,
        terms_text: ""
      })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SurveyPage />);
    expect(await screen.findByText(/welcome/i)).toBeInTheDocument();
    expect(screen.getByText("cluster")).toBeInTheDocument();
    expect(screen.getByText("Second paragraph.")).toBeInTheDocument();
    expect(screen.getByAltText("Cluster logo")).toBeInTheDocument();
    expect(screen.queryByText("Rate it")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /start survey/i }));
    expect(await screen.findByText("Rate it")).toBeInTheDocument();
    expect(screen.getByLabelText(/postleitzahl/i)).toBeInTheDocument();
  });

  it("requires an admin password before showing the admin editor", async () => {
    const fetchMock = adminFetchMock([
      jsonResponse({ authenticated: false }),
      jsonResponse({ authenticated: true }),
      jsonResponse({
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
          map_palette: "batlow",
          map_lod_levels: [5],
          is_active: true
      }),
      jsonResponse({ totalResponses: 0, postalCodeCount: 0 }),
      jsonResponse({ authenticated: false })
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Admin login")).toBeInTheDocument();
    expect(screen.queryByText("Survey settings")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText("Survey settings")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ password: "secret" })
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    expect(await screen.findByText("Admin login")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/logout",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({})
      })
    );
  });

  it("edits pages, terms, and survey data from the admin page", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const fetchMock = adminFetchMock([
      jsonResponse({ authenticated: true }),
      jsonResponse({
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
          thank_you_text: "Default thanks",
          terms_enabled: false,
          terms_text: "",
          map_palette: "batlow",
          map_lod_levels: [5],
          is_active: true
      }),
      jsonResponse({ totalResponses: 0, postalCodeCount: 0 }),
      jsonResponse({
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
          thank_you_text: "Custom **thanks**",
          terms_enabled: true,
          terms_text: "Terms go here",
          map_palette: "tokyo",
          map_lod_levels: [5],
          is_active: true
      }),
      jsonResponse({ totalResponses: 12, postalCodeCount: 3 }),
      jsonResponse({ totalResponses: 0, postalCodeCount: 0 })
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Survey settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data" })).toBeInTheDocument();
    expect(screen.getByLabelText("LOD 5")).toBeChecked();
    expect(screen.getByLabelText("LOD 5")).toBeDisabled();
    expect(screen.getByLabelText("LOD 4")).not.toBeChecked();

    fireEvent.change(screen.getByLabelText(/page title/i), { target: { value: "Intro" } });
    fireEvent.change(screen.getByLabelText(/start text/i), { target: { value: "Intro copy" } });
    fireEvent.change(screen.getByLabelText(/thank you text/i), { target: { value: "Custom **thanks**" } });
    fireEvent.change(screen.getByPlaceholderText("Strongly agree"), { target: { value: "Agree strongly" } });
    fireEvent.click(screen.getByRole("button", { name: /add question/i }));
    fireEvent.click(screen.getByRole("button", { name: /add page/i }));
    fireEvent.click(screen.getByLabelText(/enable terms/i));
    fireEvent.change(screen.getByLabelText(/terms text/i), { target: { value: "Terms go here" } });
    fireEvent.change(screen.getByLabelText(/map palette/i), { target: { value: "tokyo" } });
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
      start_text: "Intro copy",
      start_logo_data_url: "",
      thank_you_text: "Custom **thanks**",
      terms_enabled: true,
      terms_text: "Terms go here",
      use_aggregated_shapes: false,
      map_lod_levels: [5],
      map_palette: "tokyo",
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

    fireEvent.click(screen.getByRole("button", { name: "Data" }));
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

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    expect(open).toHaveBeenCalledWith("/api/admin/export.csv", "_blank");

    fireEvent.click(screen.getByRole("button", { name: /export newsletter csv/i }));
    expect(open).toHaveBeenCalledWith("/api/admin/newsletter.csv", "_blank");
  });

  it("shows and exports a QR share card from the admin share tab", async () => {
    const expectedUrl = `${window.location.origin}${window.location.pathname}#survey`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const context = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 8 }))
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,Y2FyZA==");
    const click = vi.spyOn(HTMLElement.prototype, "click").mockImplementation(() => undefined);
    const realCreateElement = document.createElement.bind(document);
    const anchors: HTMLAnchorElement[] = [];
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const element = realCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") anchors.push(element as HTMLAnchorElement);
      return element;
    }) as typeof document.createElement);
    const fetchMock = adminFetchMock([
      jsonResponse({ authenticated: true }),
      jsonResponse({
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
          map_palette: "batlow",
          map_lod_levels: [5],
          is_active: true
      }),
      jsonResponse({ totalResponses: 0, postalCodeCount: 0 })
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Survey settings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(screen.getByText(expectedUrl)).toBeInTheDocument();
    expect(await screen.findByAltText("Survey QR code")).toHaveAttribute("src", "data:image/png;base64,cXI=");
    expect(QRCode.toDataURL).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ width: 320 }));

    fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expectedUrl));
    expect(screen.getByRole("status")).toHaveTextContent("Survey link copied.");

    fireEvent.click(screen.getByRole("button", { name: /download qr card/i }));
    await waitFor(() => expect(QRCode.toCanvas).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), expectedUrl, expect.objectContaining({ width: 320 })));
    expect(anchors[0]?.download).toBe("survey-qr-card-default.png");
    expect(anchors[0]?.href).toBe("data:image/png;base64,Y2FyZA==");
    expect(click).toHaveBeenCalled();
  });

  it("saves an added admin question without requiring another editor action", async () => {
    const fetchMock = adminFetchMock([
      jsonResponse({ authenticated: true }),
      jsonResponse({
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
          map_palette: "batlow",
          map_lod_levels: [5],
          is_active: true
      }),
      jsonResponse({ totalResponses: 0, postalCodeCount: 0 }),
      (_path: string, options?: RequestInit) => textResponse(options?.body as string)
    ]);
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

  it("saves non-contiguous map LOD levels and keeps one selected", async () => {
    const fetchMock = adminFetchMock([
      jsonResponse({ authenticated: true }),
      jsonResponse({
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
          map_palette: "batlow",
          map_lod_levels: [5],
          is_active: true
      }),
      jsonResponse({ totalResponses: 0, postalCodeCount: 0 }),
      (_path: string, options?: RequestInit) => textResponse(options?.body as string)
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Survey settings")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("LOD 3"));
    fireEvent.click(screen.getByLabelText("LOD 1"));
    fireEvent.click(screen.getByLabelText("LOD 5"));
    fireEvent.click(screen.getByRole("button", { name: /save survey/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Survey saved."));
    const saveCall = fetchMock.mock.calls.find(([path]) => path === "/api/admin/survey");
    const saveBody = JSON.parse(saveCall?.[1]?.body as string);
    expect(saveBody).toMatchObject({
      use_aggregated_shapes: true,
      map_lod_levels: [3, 1]
    });
    expect(screen.getByLabelText("LOD 3")).toBeChecked();
    expect(screen.getByLabelText("LOD 1")).toBeChecked();
  });

  it("keeps local questions visible when a stale save response drops pages", async () => {
    const fetchMock = adminFetchMock([
      jsonResponse({ authenticated: true }),
      jsonResponse({
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
          map_palette: "batlow",
          map_lod_levels: [5],
          is_active: true
      }),
      jsonResponse({ totalResponses: 0, postalCodeCount: 0 }),
      jsonResponse({
          id: "active",
          title: "Test",
          question_text: "Rate it",
          min_rating: -3,
          max_rating: 3,
          rating_labels: {},
          is_active: true
      })
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage />);
    expect(await screen.findByText("Survey settings")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add question/i }));
    fireEvent.click(screen.getByRole("button", { name: /save survey/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Frontend/backend mismatch"));
    expect(screen.getByText("Question 2")).toBeInTheDocument();
  });
});

describe("frontend map page", () => {
  it("loads survey, PLZ shapes, palette, and aggregate results", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = mapFetchMock([
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 1, average: 2, sum: 2, hidden: false }] }]
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<MapPage />);

    expect(await screen.findByRole("heading", { name: "Rate it" })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-map")).toHaveTextContent("1");
    expect(screen.getByText("1 responses")).toBeInTheDocument();
    expect(screen.getByText("1 PLZ areas")).toBeInTheDocument();
    expect(FakeEventSource.instances[0]?.url).toBe("/api/results/active/stream");
    expect(fetchMock).toHaveBeenCalledWith("/data/germany-plz.topojson.json");
    expect(fetchMock).toHaveBeenCalledWith("/data/gradients/batlow.txt");
  });

  it("loads the GeoJSON level 1 shape file first when aggregated shapes are enabled", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = mapFetchMock([
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 1, average: 2, sum: 2, hidden: false }] }]
    ], true);
    vi.stubGlobal("fetch", fetchMock);

    render(<MapPage />);

    expect(await screen.findByRole("heading", { name: "Rate it" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/data/germany-plz-1.topojson.json");
  });

  it("loads the coarsest selected map LOD first", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = mapFetchMock([
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 1, average: 2, sum: 2, hidden: false }] }]
    ], true, [5, 3]);
    vi.stubGlobal("fetch", fetchMock);

    render(<MapPage />);

    expect(await screen.findByRole("heading", { name: "Rate it" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/data/germany-plz-3.topojson.json");
  });

  it("refreshes result data manually without reloading PLZ shapes", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = mapFetchMock([
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 1, average: 2, sum: 2, hidden: false }] }],
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 2, average: 3, sum: 6, hidden: false }] }]
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<MapPage />);
    expect(await screen.findByTestId("mock-map")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: /refresh results/i }));

    await waitFor(() => expect(screen.getByTestId("mock-map")).toHaveTextContent("2"));
    expect(screen.getByRole("status")).toHaveTextContent("Results updated.");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/results/active")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/data/germany-plz.topojson.json")).toHaveLength(1);
  });

  it("uses SSE updates as result refresh triggers without reloading PLZ shapes", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = mapFetchMock([
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 1, average: 2, sum: 2, hidden: false }] }],
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 3, average: 1, sum: 3, hidden: false }] }]
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<MapPage />);
    expect(await screen.findByTestId("mock-map")).toHaveTextContent("1");

    act(() => {
      FakeEventSource.instances[0].emit("aggregate-update", {
        type: "aggregate-update",
        survey_id: "active"
      });
    });

    await waitFor(() => expect(screen.getByTestId("mock-map")).toHaveTextContent("3"));
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/results/active")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/data/germany-plz.topojson.json")).toHaveLength(1);
  });

  it("refreshes result data on window focus without reloading PLZ shapes", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = mapFetchMock([
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 1, average: 2, sum: 2, hidden: false }] }],
      [{ question_id: "q-1", aggregates: [{ question_id: "q-1", postal_code: "10115", count: 4, average: 2, sum: 8, hidden: false }] }]
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(<MapPage />);
    expect(await screen.findByTestId("mock-map")).toHaveTextContent("1");

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(screen.getByTestId("mock-map")).toHaveTextContent("4"));
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/results/active")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/data/germany-plz.topojson.json")).toHaveLength(1);
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

  it("falls back to the nearest enabled PLZ level and prefers finer ties", () => {
    expect(nearestEnabledPlzLevel(4, [5, 3, 1])).toBe(5);
    expect(nearestEnabledPlzLevel(2, [5, 3, 1])).toBe(3);
    expect(nearestEnabledPlzLevel(1, [5, 3])).toBe(3);
  });

  it("adapts color scale outside the default -3 to +3 range", () => {
    expect(colorForAverage(-5, -5, 5)).toBe("rgb(37, 99, 235)");
    expect(colorForAverage(5, -5, 5)).toBe("rgb(220, 38, 38)");
    expect(colorForAverage(null, -5, 5)).toBe("#e5e7eb");
    expect(colorForAverage(1, -5, 5, true)).toBe("#9ca3af");
  });

  it("maps continuous Scientific Colour Maps text to interpolated colors", () => {
    const palette = parsePaletteText("0 0 0\n1 0.5 0");
    expect(colorForAverage(-5, -5, 5, false, palette)).toBe("rgb(0, 0, 0)");
    expect(colorForAverage(5, -5, 5, false, palette)).toBe("rgb(255, 128, 0)");
    expect(colorForAverage(0, -5, 5, false, palette)).toBe("rgb(128, 64, 0)");
  });
});
