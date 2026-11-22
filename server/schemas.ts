import { z } from "zod";
import { MAX_DRAFT_BATCH } from "../src/data/songs.ts";

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const label = z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/);
export const title = z.string().trim().min(1).max(120);
export const lines = z.array(z.string().trim().min(1).max(240)).min(1).max(12);
export const studioFields = z.object({
  title, lines, admin_feeling: label, feeling_key: label,
  theme: z.string().trim().min(1).max(240),
  mood: z.string().trim().min(1).max(80),
  tempo_bpm: z.number().int().min(70).max(100),
  instruments: z.string().trim().min(1).max(300),
  vocal_tone: z.string().trim().min(1).max(300),
}).strict();
export const editFields = studioFields.omit({ feeling_key: true }).partial().refine(
  (value) => Object.keys(value).length > 0, "No changes supplied."
);
export const musicModels = z.enum(["lyria-3-clip-preview", "lyria-3.5"]);
export const autopilotSettings = z.object({
  enabled: z.boolean(), daily_budget_usd: z.number().finite().min(0).max(1000),
  max_new_songs: z.number().int().min(0).max(12), max_takes_per_song: z.number().int().min(1).max(4),
  run_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5][05]$/), daily_report: z.boolean(),
}).strict();
export const studioSettings = z.object({
  feelings: z.array(label).min(1).max(30),
  lines_per_song: z.number().int().min(1).max(12),
  rhyme_scheme: z.enum(["AABB", "ABAB", "MONO", "OFF"]),
  max_words_per_line: z.number().int().min(1).max(15),
  forbidden_words: z.array(z.string().trim().min(1).max(80)).max(100),
  block_substrings: z.boolean(),
  no_numbers_prices_brands: z.boolean(),
  default_model: musicModels,
  autopilot: autopilotSettings.optional(),
  text_model: z.string().trim().max(64).regex(/^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/).optional(),
  quality_checks: z.boolean().optional(),
  target_length: z.number().int().min(28).max(44),
  daily_budget_usd: z.number().finite().min(0).max(1000).optional(),
}).strict();
export const batchLimit = MAX_DRAFT_BATCH;
export const saveDraft = studioFields.extend({ isApproved: z.boolean().default(false) });
export type SaveDraft = z.infer<typeof saveDraft>;
export const empty = z.object({}).strict();
export const ids = z.object({ id }).strict();
export const importHistory = z.array(z.object({
  source: z.string().trim().min(1).max(120),
  id: z.string().trim().min(1).max(128),
  feeling: label, title, lines,
}).strict()).min(1).max(500);

export type Draft = z.infer<typeof studioFields>;
