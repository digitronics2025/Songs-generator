import type { Firestore } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeDrafts } from "../server/catalog.ts";
import { DEFAULT_STUDIO_SETTINGS } from "../src/data/songs.ts";
import { createGeminiModelCheck, Gemini } from "../server/gemini.ts";

const api = vi.hoisted(() => ({ generateContent: vi.fn(), get: vi.fn(), reserveBudget: vi.fn() }));
vi.mock("@google/genai", () => ({
  ThinkingLevel: { LOW: "LOW" },
  GoogleGenAI: class { models = { generateContent: api.generateContent, get: api.get }; },
}));
vi.mock("../server/limits.ts", () => ({ reserveBudget: api.reserveBudget }));

const model = "gemini-4-hydrogen";
const key = "fixture-api-key-private";
const wav = Buffer.from("synthetic local audio fixture".repeat(10));
const db = {} as Firestore;
const valid = { transcript: "سلام عليكم", voice_start: 0.2, voice_end: 26.9 };
function reply(text?: string, finishReason = "STOP") {
  return { text, candidates: [{ finishReason }],
    usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12, thoughtsTokenCount: 30, totalTokenCount: 132 } };
}

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", key);
  vi.stubEnv("STUDIO_EMULATOR", "0");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("returns an editable draft after exactly one paid rhyme retry", async () => {
  const lines = ["بابا", "كتفي", "حنا", "معانا", "سنين", "تعبانين"];
  api.generateContent.mockResolvedValue(reply(JSON.stringify({ title: "دار", lines, theme: "home", mood: "warm",
    tempo_bpm: 80, instruments: "oud", vocal_tone: "soft", feeling_key: "home" })));
  const history = { collection: () => ({ get: async () => ({ docs: [] }) }) } as unknown as Firestore;
  const { drafts } = await proposeDrafts(history, DEFAULT_STUDIO_SETTINGS, ["family_evening"], 1, "");
  expect(api.generateContent).toHaveBeenCalledTimes(2);
  expect(api.reserveBudget).toHaveBeenCalledTimes(2);
  expect(drafts[0].validation.valid).toBe(false);
  expect(drafts[0].validation.errors[0]).toContain("don't rhyme");
  expect(drafts[0].lines).toEqual(lines);
});

it.each(["AABB", "OFF"] as const)("drafts with the %s rhyme setting", async rhyme_scheme => {
  api.generateContent.mockResolvedValue(reply(JSON.stringify({ title: "دار", lines: ["حنا"], rhyme_scheme,
    rhyme_endings: ["نا"], theme: "home", mood: "warm", tempo_bpm: 80, instruments: "oud",
    vocal_tone: "soft", feeling_key: "home" })));
  await new Gemini(db).draft("family_evening", "", { ...DEFAULT_STUDIO_SETTINGS, rhyme_scheme }, []);
  const prompt = api.generateContent.mock.calls[0][0].contents;
  for (const instruction of ["Rhyme scheme AABB", "last two letters match", "Never rhyme a word with itself", "within ±2", "Return rhyme_endings"]) {
    expect(prompt.includes(instruction)).toBe(rhyme_scheme === "AABB");
  }
});

describe("Gemini vocal check", () => {
  it("uses the configured model and the nullable JSON schema and preserves valid null timestamps", async () => {
    api.generateContent.mockResolvedValue(reply(JSON.stringify({ ...valid, voice_start: null })));
    const result = await new Gemini(db).transcribe(wav, 30, "gemini-2.5-flash");
    expect(result).toEqual({ ...valid, voice_start: null });
    expect(api.generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-2.5-flash",
      config: expect.objectContaining({ maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 },
        responseJsonSchema: expect.objectContaining({ properties: expect.objectContaining({
          voice_start: { type: ["number", "null"] }, voice_end: { type: ["number", "null"] },
        }) }),
      }),
    }));
  });

  it("recovers one complete JSON object in surrounding text and clamps timestamps", async () => {
    const content = { transcript: 'سلام "{ عليكم }"', voice_start: -0.12, voice_end: 31.2 };
    api.generateContent.mockResolvedValue(reply("Transcript follows\n---\n" + JSON.stringify(content) + "\nTrailing text."));
    expect(await new Gemini(db).transcribe(wav, 30, model)).toEqual({ ...content, voice_start: 0, voice_end: 30 });
    expect(api.generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model, config: expect.objectContaining({ thinkingConfig: { thinkingLevel: "LOW" } }),
    }));
    expect(api.reserveBudget).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["MAX_TOKENS", reply('{"transcript":', "MAX_TOKENS"), /ran out of output tokens/],
    ["SAFETY", { ...reply(), candidates: [], promptFeedback: { blockReason: "SAFETY" } }, /for safety/],
    ["EMPTY_REPLY", reply("   "), /empty vocal-check/],
    ["INVALID_TRANSCRIPT", reply('{"transcript": "cut off'), /incomplete or invalid/],
  ])("retries %s once and returns a clear failure if the second reply also fails", async (code, response, message) => {
    api.generateContent.mockResolvedValue(response);
    await expect(new Gemini(db).transcribe(wav, 30, model)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(message) });
    expect(api.generateContent).toHaveBeenCalledTimes(2);
    expect(api.reserveBudget).toHaveBeenCalledTimes(2);
    const diagnostics = vi.mocked(console.warn).mock.calls.map(([serialized]) => JSON.parse(String(serialized)));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ event: "gemini_call_failed", model, error_code: code,
      finishReason: expect.any(String), token_usage: { input: 90, output: 12, thinking: 30, total: 132 },
    });
  });

  it("recovers on the budgeted retry and redacts audio and the configured key from diagnostics", async () => {
    api.generateContent.mockResolvedValueOnce(reply(key + " " + wav.toString("base64") + " " + "abc ".repeat(100), "MAX_TOKENS"))
      .mockResolvedValueOnce(reply(JSON.stringify(valid)));
    expect(await new Gemini(db).transcribe(wav, 30, model)).toEqual(valid);
    const [{ reply_preview }] = vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(reply_preview).toHaveLength(200);
    expect(reply_preview).not.toContain(key);
    expect(reply_preview).not.toContain(wav.toString("base64").slice(0, 24));
    expect(api.reserveBudget).toHaveBeenNthCalledWith(2, db, 60_000, undefined);
  });

  it("does not dispatch a second call if the budget rejects the retry", async () => {
    api.generateContent.mockResolvedValue(reply(""));
    api.reserveBudget.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Budget reached"));
    await expect(new Gemini(db).transcribe(wav, 30, model)).rejects.toThrow("Budget reached");
    expect(api.generateContent).toHaveBeenCalledTimes(1);
  });

  it("keeps the provider's error text out of generation errors", async () => {
    api.generateContent.mockRejectedValue(Object.assign(new Error(key + wav.toString("base64")), { status: 404 }));
    const error: unknown = await new Gemini(db).transcribe(wav, 30, model).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 502, message: "The configured Gemini model is unavailable." });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(key);
  });
});

it("checks only model metadata, caches concurrent checks and detects a changed unavailable model", async () => {
  api.get.mockResolvedValueOnce({ supportedActions: ["generateContent"] }).mockRejectedValueOnce({ status: 404 });
  const check = createGeminiModelCheck();
  expect(await Promise.all([check(model), check(model)])).toEqual([true, true]);
  expect(await check("gemini-missing")).toBe(false);
  expect(api.get.mock.calls).toEqual([[{ model }], [{ model: "gemini-missing" }]]);
  expect(api.generateContent).not.toHaveBeenCalled();
  expect(api.reserveBudget).not.toHaveBeenCalled();
});
