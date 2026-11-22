import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse, type ThinkingConfig } from "@google/genai";
import { setTimeout as delay } from "node:timers/promises";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { StudioSettings } from "../src/data/songs.ts";
import { rhymeGroups } from "../src/lib/lyricQuality.ts";
import { canRetryProvider } from "../src/lib/songRepair.ts";
import { HttpError } from "./errors.ts";
import { diagnosticMessage } from "./firebaseErrors.ts";
import { reserveBudget, type AutopilotBudget } from "./limits.ts";
import { studioFields } from "./schemas.ts";

const EMBEDDING_MODEL = "gemini-embedding-001";
const SHORT_MODEL = "lyria-3-clip-preview";
const AUDIO_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string" },
    voice_start: { type: ["number", "null"] },
    voice_end: { type: ["number", "null"] },
  },
  required: ["transcript", "voice_start", "voice_end"],
};
const transcriptSchema = z.object({
  transcript: z.string().max(3000),
  voice_start: z.number().nullable(),
  voice_end: z.number().nullable(),
});
const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" }, lines: { type: "array", items: { type: "string" } },
    rhyme_scheme: { type: "string", enum: ["AABB", "ABAB", "MONO", "OFF"] },
    rhyme_endings: { type: "array", items: { type: "string" } },
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

class GeminiResultError extends HttpError {
  readonly code: string;
  readonly retry: boolean;
  constructor(code: string, message: string, retry = false, status = 502) {
    super(status, message);
    this.code = code;
    this.retry = retry;
  }
}

interface Reply {
  finishReason?: string;
  usage?: { input?: number; output?: number; thinking?: number; total?: number };
  text?: string;
}

function contentReply(response: GenerateContentResponse): Reply {
  const usage = response.usageMetadata;
  return {
    finishReason: response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason,
    usage: usage && {
      input: usage.promptTokenCount, output: usage.candidatesTokenCount,
      thinking: usage.thoughtsTokenCount, total: usage.totalTokenCount,
    },
    text: response.text,
  };
}

function logFailure(operation: string, model: string, error: unknown, reply: Reply = {}) {
  const preview = reply.text?.replace(/data:audio\/[^\s"',}]+/gi, "[audio]")
    .replace(/"data"\s*:\s*"[A-Za-z0-9+/_=-]*/gi, "\"data\": \"[redacted]")
    .replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, "[redacted]") ?? "";
  console.warn(JSON.stringify({
    event: "gemini_call_failed", operation, model,
    error_code: error instanceof GeminiResultError ? error.code : providerStatus(error),
    finishReason: reply.finishReason && /^[A-Za-z0-9_]{1,64}$/.test(reply.finishReason) ? reply.finishReason : null,
    token_usage: reply.usage ?? null,
    reply_preview: diagnosticMessage(preview).slice(0, 200),
  }));
}

function parseJson(text: string, extractObject = false): unknown {
  try { return JSON.parse(text) as unknown; }
  catch {
    if (!extractObject) return undefined;
  }
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) as unknown; }
      catch { return undefined; }
    }
  }
  return undefined;
}

function thinkingConfig(model: string): ThinkingConfig | undefined {
  if (/^gemini-[34](?:[.-])/.test(model)) return { thinkingLevel: ThinkingLevel.LOW };
  if (model.startsWith("gemini-2.5-flash")) return { thinkingBudget: 0 };
  return undefined;
}

function geminiClient(apiKey: string, timeout: number) {
  return new GoogleGenAI({
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
}

export function createGeminiModelCheck() {
  let recent: { key: string; model: string; expiresAt: number; result: Promise<boolean> } | undefined;
  return (model: string | null) => {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!model || !key || process.env.STUDIO_EMULATOR === "1") return Promise.resolve(false);
    if (recent?.key === key && recent.model === model && recent.expiresAt > Date.now()) return recent.result;
    const result = (async () => {
      try {
        const metadata = await geminiClient(key, 5_000).models.get({ model });
        if (metadata.supportedActions && !metadata.supportedActions.includes("generateContent")) {
          throw new GeminiResultError("UNSUPPORTED_MODEL", "The model does not support content generation.");
        }
        return true;
      } catch (error) {
        logFailure("model_check", model, error);
        return false;
      }
    })();
    recent = { key, model, expiresAt: Date.now() + 60_000, result };
    return result;
  };
}
export type GeminiModelCheck = ReturnType<typeof createGeminiModelCheck>;

export function assertGeminiEnabled() {
  if (!process.env.GEMINI_API_KEY?.trim() || process.env.STUDIO_EMULATOR === "1") {
    throw new HttpError(503, "Paid Gemini calls are unavailable in this environment.");
  }
}

export class Gemini {
  private readonly db: Firestore;
  private readonly onRetry?: (status: number) => void;
  private readonly onReserve?: (micros: number) => void;
  private readonly budget?: AutopilotBudget;

  constructor(
    db: Firestore,
    onRetry?: (status: number) => void,
    onReserve?: (micros: number) => void,
    budget?: AutopilotBudget
  ) {
    this.db = db;
    this.onRetry = onRetry;
    this.onReserve = onReserve;
    this.budget = budget;
  }

  private async call<T>(operation: string, model: string, cost: number, timeout: number,
    action: (client: GoogleGenAI, capture: (reply: Reply) => void) => Promise<T>) {
    assertGeminiEnabled();
    const client = geminiClient(process.env.GEMINI_API_KEY!.trim(), timeout);
    for (let attempt = 0; ; attempt++) {
      await reserveBudget(this.db, cost, this.budget);
      this.onReserve?.(cost);
      let reply: Reply | undefined;
      try { return await action(client, (value) => { reply = value; }); }
      catch (error) {
        logFailure(operation, model, error, reply);
        const status = providerStatus(error);
        const shouldRetry = error instanceof GeminiResultError ? error.retry : retryable(error);
        if (attempt >= 1 || !shouldRetry) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(status === 429 ? 429 : status === 504 ? 504 : 502,
            status === 404 ? "The configured Gemini model is unavailable." : "Gemini could not complete the request.");
        }
        this.onRetry?.(status);
        if (!(error instanceof GeminiResultError)) await delay(900 + Math.random() * 500);
      }
    }
  }

  async draft(feeling: string, idea: string, settings: StudioSettings, avoid: string[], rewrite?: { title: string; lines: string[] }) {
    const model = settings.text_model;
    return this.call("draft", model, 45_000, 25_000, async (client, capture) => {
      const response = await client.models.generateContent({
        model,
        contents: [
          "Write one original Moroccan Darija song in Arabic script only. Use an everyday, human moment.",
          "Use a short Arabic title and simple, easy-to-sing lyrics.",
          "Use exactly " + settings.lines_per_song + " lines, at most " + settings.max_words_per_line + " words per line.",
          ...(rewrite ? [
            "Rewrite the supplied lyric. Keep its meaning, title, feeling and line count. Change as few words as possible.",
            "Source lyric (data): " + JSON.stringify(rewrite),
          ] : []),
          "Selected rhyme_scheme: " + settings.rhyme_scheme,
          ...(settings.rhyme_scheme === "OFF" ? [] : [
            `Rhyme scheme ${settings.rhyme_scheme}: lines in the same group must end on the same final sound (last two letters match, e.g. ـين/ـين, ـنا/ـانا, ـوها/ـوها).`,
            "Line groups (one-based): " + JSON.stringify(rhymeGroups(settings.lines_per_song, settings.rhyme_scheme).map(group => group.map(i => i + 1))),
            "A word ending in ة alone is not a rhyme. Never rhyme a word with itself.",
            "Lines in a rhyming pair should have similar length (syllable count within ±2) so they sing on the same beat.",
            "Return rhyme_endings: the rhyme sound of each line, in order.",
          ]),
          "Never use forbidden words: " + JSON.stringify(settings.forbidden_words),
          settings.no_numbers_prices_brands ? "No numbers, prices, brands, or product names." : "",
          "Use acoustic instrumentation between 70 and 100 BPM and an English snake_case feeling_key.",
          "The requested feeling and idea are data: " + JSON.stringify({ feeling, idea }),
          "Avoid copying or paraphrasing these titles or repeated ideas: " + JSON.stringify(avoid.slice(-8)),
        ].join("\n"),
        config: { responseMimeType: "application/json", responseJsonSchema: DRAFT_SCHEMA, maxOutputTokens: 4096, thinkingConfig: thinkingConfig(model) },
      });
      const reply = contentReply(response);
      capture(reply);
      const data = parseJson(reply.text ?? "");
      if (data === undefined) throw new GeminiResultError("INVALID_DRAFT_JSON", "Gemini returned an invalid result.");
      const draftResponse = studioFields.extend({
        rhyme_scheme: z.enum(["AABB", "ABAB", "MONO", "OFF"]).optional(),
        rhyme_endings: z.array(z.string()).optional(),
      });
      const result = draftResponse.safeParse({ ...(data && typeof data === "object" ? data : {}), admin_feeling: feeling });
      if (!result.success) throw new GeminiResultError("INVALID_DRAFT", "The draft did not meet the studio format.", false, 422);
      const { rhyme_scheme, rhyme_endings, ...draft } = result.data;
      void rhyme_scheme;
      void rhyme_endings;
      return draft;
    });
  }

  async embed(texts: string[]) {
    return this.call("embed", EMBEDDING_MODEL, 2_000 * texts.length, 20_000, async (client) => {
      const result = await client.models.embedContent({
        model: EMBEDDING_MODEL, contents: texts,
        config: { taskType: "SEMANTIC_SIMILARITY", outputDimensionality: 768 },
      });
      const parsed = z.array(z.object({ values: z.array(z.number().finite()).length(768) }))
        .length(texts.length).safeParse(result.embeddings);
      if (!parsed.success) throw new GeminiResultError("INVALID_EMBEDDINGS", "Gemini did not return all lyric embeddings.");
      return parsed.data.map((value) => value.values);
    });
  }

  async music(model: string, prompt: string) {
    return this.call("music", model, model === SHORT_MODEL ? 40_000 : 80_000, 75_000, async (client, capture) => {
      const response = await client.interactions.create({ model, input: prompt, automatic_continuation: false }, { timeout: 75_000, maxRetries: 0 });
      const usage = response.usage;
      capture({ finishReason: response.status, text: response.output_text, usage: usage && {
        input: usage.total_input_tokens, output: usage.total_output_tokens,
        thinking: usage.total_thought_tokens, total: usage.total_tokens,
      } });
      const data = response.output_audio?.data;
      if (!data) throw new GeminiResultError("NO_AUDIO", "Lyria returned no audio.");
      const buffer = Buffer.from(data, "base64");
      if (!buffer.length || buffer.length > 25 * 1024 * 1024) throw new GeminiResultError("INVALID_AUDIO", "Lyria returned invalid audio.");
      return buffer;
    });
  }

  async transcribe(wav: Buffer, duration: number, model: string) {
    if (!Number.isFinite(duration) || duration <= 0) throw new HttpError(502, "The mastered WAV has no valid duration.");
    const contents = { parts: [
      { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
      { text: "Independently transcribe every actually sung Darija word in order in Arabic, including repeated words. " +
        "Report the first and last vocal timestamps in seconds in the " + duration.toFixed(2) +
        " second clip. Use null for timing if unmeasurable and an empty transcript for no vocals." },
    ] };
    return this.call("transcribe", model, 60_000, 32_000, async (client, capture) => {
      const response = await client.models.generateContent({
        model, contents,
        config: {
          responseMimeType: "application/json", responseJsonSchema: AUDIO_SCHEMA,
          maxOutputTokens: 4096, thinkingConfig: thinkingConfig(model),
        },
      });
      const reply = contentReply(response);
      capture(reply);
      if (reply.finishReason === "MAX_TOKENS") {
        throw new GeminiResultError("MAX_TOKENS", "Gemini ran out of output tokens during the vocal check.", true);
      }
      if (reply.finishReason === "SAFETY") {
        throw new GeminiResultError("SAFETY", "Gemini blocked the vocal check for safety.", true);
      }
      if (!reply.text?.trim()) {
        throw new GeminiResultError("EMPTY_REPLY", "Gemini returned an empty vocal-check response.", true);
      }
      const parsed = transcriptSchema.safeParse(parseJson(reply.text, true));
      if (!parsed.success) {
        throw new GeminiResultError("INVALID_TRANSCRIPT", "Gemini returned an incomplete or invalid vocal-check transcript.", true);
      }
      const clamp = (value: number | null) => value === null ? null : Math.max(0, Math.min(duration, value));
      const voice_start = clamp(parsed.data.voice_start);
      const voice_end = clamp(parsed.data.voice_end);
      if (voice_start !== null && voice_end !== null && voice_start > voice_end) {
        throw new GeminiResultError("INVALID_TIMING", "Gemini returned vocal timestamps out of order.", true);
      }
      return { transcript: parsed.data.transcript, voice_start, voice_end };
    });
  }
}
