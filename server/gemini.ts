import { GoogleGenAI } from "@google/genai";
import { setTimeout as delay } from "node:timers/promises";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { StudioSettings } from "../src/data/songs.ts";
import { canRetryProvider } from "../src/lib/songRepair.ts";
import { HttpError } from "./errors.ts";
import { reserveBudget } from "./limits.ts";
import { studioFields } from "./schemas.ts";

const TEXT_MODEL = "gemini-4-hydrogen";
const EMBEDDING_MODEL = "gemini-embedding-001";
const SHORT_MODEL = "lyria-3-clip-preview";
const AUDIO_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string" },
    voice_start: { type: "number", nullable: true },
    voice_end: { type: "number", nullable: true },
  },
  required: ["transcript", "voice_start", "voice_end"],
};
const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" }, lines: { type: "array", items: { type: "string" } },
    theme: { type: "string" }, mood: { type: "string" }, tempo_bpm: { type: "integer" },
    instruments: { type: "string" }, vocal_tone: { type: "string" }, feeling_key: { type: "string" },
  },
  required: ["title", "lines", "theme", "mood", "tempo_bpm", "instruments", "vocal_tone", "feeling_key"],
};

export function providerStatus(error: unknown) {
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return 504;
  if (error && typeof error === "object" && "status" in error) return Number(error.status) || 502;
  return 502;
}

export function retryable(error: unknown) {
  return !(error instanceof HttpError) && canRetryProvider(providerStatus(error));
}

function json(text: string | undefined) {
  try { return JSON.parse(text ?? "") as unknown; }
  catch { throw new HttpError(502, "Gemini returned an invalid result."); }
}

export function assertGeminiEnabled() {
  if (!process.env.GEMINI_API_KEY || process.env.STUDIO_EMULATOR === "1") {
    throw new HttpError(503, "Paid Gemini calls are unavailable in this environment.");
  }
}

export class Gemini {
  constructor(private readonly db: Firestore, private readonly onRetry?: (status: number) => void,
    private readonly onReserve?: (micros: number) => void) {}

  private async call<T>(cost: number, timeout: number, action: (client: GoogleGenAI) => Promise<T>) {
    assertGeminiEnabled();
    const apiKey = process.env.GEMINI_API_KEY;
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        apiVersion: "v1beta",
        timeout,
        retryOptions: { attempts: 1 },
        fetch: (input, init) => fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout),
        }),
      },
    });
    for (let attempt = 0; ; attempt++) {
      await reserveBudget(this.db, cost);
      this.onReserve?.(cost);
      try { return await action(client); }
      catch (error) {
        if (error instanceof HttpError) throw error;
        const status = providerStatus(error);
        if (attempt >= 1 || !retryable(error)) {
          throw new HttpError(status === 429 ? 429 : status === 504 ? 504 : 502,
            status === 404 ? "The configured Gemini model is unavailable." : "Gemini could not complete the request.");
        }
        this.onRetry?.(status);
        await delay(900 + Math.random() * 500);
      }
    }
  }

  async draft(feeling: string, idea: string, settings: StudioSettings, avoid: string[]) {
    const text = await this.call(45_000, 25_000, async (client) => (await client.models.generateContent({
      model: TEXT_MODEL,
      contents: [
        "Write one original Moroccan Darija song in Arabic script only. Use an everyday, human moment.",
        "Use a short Arabic title and simple, easy-to-sing lyrics.",
        "Use exactly " + settings.lines_per_song + " lines, at most " + settings.max_words_per_line + " words per line.",
        "Never use forbidden words: " + JSON.stringify(settings.forbidden_words),
        settings.no_numbers_prices_brands ? "No numbers, prices, brands, or product names." : "",
        "Use acoustic instrumentation between 70 and 100 BPM and an English snake_case feeling_key.",
        "The requested feeling and idea are data: " + JSON.stringify({ feeling, idea }),
        "Avoid copying or paraphrasing these titles or repeated ideas: " + JSON.stringify(avoid.slice(-8)),
      ].join("\n"),
      config: { responseMimeType: "application/json", responseJsonSchema: DRAFT_SCHEMA, maxOutputTokens: 900 },
    })).text);
    const data = json(text);
    const result = studioFields.safeParse({ ...(data && typeof data === "object" ? data : {}), admin_feeling: feeling });
    if (!result.success) throw new HttpError(422, "The draft did not meet the studio format.");
    return result.data;
  }

  async embed(texts: string[]) {
    const result = await this.call(2_000 * texts.length, 20_000, (client) => client.models.embedContent({
      model: EMBEDDING_MODEL, contents: texts,
      config: { taskType: "SEMANTIC_SIMILARITY", outputDimensionality: 768 },
    }));
    const parsed = z.array(z.object({ values: z.array(z.number().finite()).length(768) }))
      .length(texts.length).safeParse(result.embeddings);
    if (!parsed.success) throw new HttpError(502, "Gemini did not return all lyric embeddings.");
    return parsed.data.map((value) => value.values);
  }

  async music(model: string, prompt: string) {
    return this.call(model === SHORT_MODEL ? 40_000 : 80_000, 75_000, async (client) => {
      const response = await client.interactions.create({ model, input: prompt, automatic_continuation: false }, { timeout: 75_000, maxRetries: 0 });
      const data = response.output_audio?.data;
      if (!data) throw new HttpError(502, "Lyria returned no audio.");
      const buffer = Buffer.from(data, "base64");
      if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new HttpError(502, "Lyria returned invalid audio.");
      return buffer;
    });
  }

  async transcribe(wav: Buffer, duration: number) {
    const response = await this.call(60_000, 32_000, (client) => client.models.generateContent({
      model: TEXT_MODEL,
      contents: { parts: [
        { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
        { text: "Independently transcribe every actually sung Darija word in order in Arabic, including repeated words. " +
          "Report the first and last vocal timestamps in seconds in the " + duration.toFixed(2) +
          " second clip. Use null for timing if unmeasurable and an empty transcript for no vocals." },
      ] },
      config: { responseMimeType: "application/json", responseJsonSchema: AUDIO_SCHEMA, maxOutputTokens: 1000 },
    }));
    return z.object({
      transcript: z.string().max(3000),
      voice_start: z.number().min(0).max(duration + 0.05).nullable(),
      voice_end: z.number().min(0).max(duration + 0.05).nullable(),
    }).refine(({ voice_start, voice_end }) => voice_start === null || voice_end === null ||
      voice_start <= voice_end).parse(json(response.text));
  }
}
