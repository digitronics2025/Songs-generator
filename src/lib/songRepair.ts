import { normalizeArabicText, validateLyrics } from "./lyricQuality.ts";

export type GenerationStage = "lyria" | "raw_upload" | "raw_download" | "master_pass1" | "master_pass2" |
  "master_measure" | "wav_upload" | "wav_download" | "transcribe" | "lyric_repair" | "claim" | "finalize";

export interface GenerationFailureDetail {
  stage: GenerationStage;
  message: string;
}

export interface RepairLogEntry {
  id: string;
  timestamp: string;
  check_failed: string;
  what_was_changed: string;
  result: string;
  estimated_cost: number;
}

export interface ProposedLyric {
  title: string;
  lines: string[];
  reason: string;
  created_at: string;
}

export interface AudioMetrics {
  duration_seconds: number | null;
  lufs: number | null;
  true_peak_db: number | null;
  words_heard_pct: number | null;
  voice_start: number | null;
  voice_end: number | null;
  missing_words: string[];
  extra_words: string[];
  repeated_words?: string[];
}

export function repeatedExtras(extra: string[], lyrics: string[]) {
  const expected = new Set(normalizeArabicText(lyrics.join(" ")).split(" "));
  return [...new Set(extra.filter((word) => expected.has(normalizeArabicText(word))))];
}

export function checkPersistentMissingWord(takes: Array<{ missing_words?: string[] }>) {
  const previous = new Set(takes.at(-2)?.missing_words?.map(normalizeArabicText) ?? []);
  return takes.at(-1)?.missing_words?.find((word) => previous.has(normalizeArabicText(word)));
}

export function audioFailures(audio: AudioMetrics) {
  const failures: string[] = [];
  if (audio.words_heard_pct === null || audio.words_heard_pct < 90) failures.push("WORDS_HEARD_LOW");
  if (audio.extra_words.length || audio.repeated_words?.length) failures.push("EXTRA_WORDS");
  if (audio.voice_start === null || audio.voice_start < 0 || audio.voice_start > 1) failures.push("VOICE_START");
  if (audio.voice_end === null || audio.voice_end < (audio.voice_start ?? 0) || audio.voice_end > 27) failures.push("VOICE_END");
  if (audio.duration_seconds === null || audio.duration_seconds < 28 || audio.duration_seconds > 45) failures.push("LENGTH_INVALID");
  if (audio.lufs === null || audio.lufs < -15 || audio.lufs > -13) failures.push("LOUDNESS_FAILURE");
  if (audio.true_peak_db === null || audio.true_peak_db > -1) failures.push("PEAK_FAILURE");
  return failures;
}

export function canRetryProvider(status: number) {
  return [429, 500, 502, 503, 504].includes(status);
}

export type RepairAction =
  | { type: "NONE"; reason: string }
  | { type: "REQUEST_LYRIC_FIX"; reason: string }
  | { type: "REMASTER"; reason: string; source: "raw" | "wav"; takeIndex: number }
  | { type: "AWAIT_VOCALS"; reason: string }
  | { type: "NEW_TAKE"; reason: string; tempo: number; directive: string };

export function decideRepairAction(
  song: { lines: string[]; tempo_bpm: number },
  takes: Array<AudioMetrics & { storage_path?: string | null; raw_storage_path?: string | null;
    status?: string; is_approved?: boolean; vocal_check_pending?: boolean }>,
  settings?: Parameters<typeof validateLyrics>[1],
): RepairAction {
  const raw = takes.reduce((found, take, index) => take.status === "failed" && !take.is_approved &&
    take.raw_storage_path && !take.storage_path ? index : found, -1);
  if (raw !== -1) return { type: "REMASTER", source: "raw", takeIndex: raw, reason: "Master saved source audio." };
  const recent = takes.filter((take) => Boolean(take.storage_path?.endsWith(".wav")));
  const last = recent.at(-1);
  if (last?.vocal_check_pending) return { type: "AWAIT_VOCALS", reason: "Mastered audio is waiting for a vocal check." };
  const lyric = validateLyrics(song.lines, settings);
  if (!lyric.valid) return { type: "REQUEST_LYRIC_FIX", reason: lyric.errors.join(" ") };
  const failures = last ? audioFailures(last) : ["NO_MEASURED_AUDIO"];
  if (last && !failures.length && last.status !== "failed") return { type: "NONE", reason: "The last take passed." };
  const persistent = checkPersistentMissingWord(recent);
  if (persistent) return { type: "REQUEST_LYRIC_FIX", reason: "Repeatedly missing word: " + persistent };
  const reason = failures.join(", ");
  if (last && !last.is_approved && failures.length && failures.every((code) => ["LOUDNESS_FAILURE", "PEAK_FAILURE"].includes(code))) {
    return { type: "REMASTER", source: "wav", takeIndex: takes.indexOf(last), reason };
  }
  return {
    type: "NEW_TAKE", reason, tempo: Math.max(70, song.tempo_bpm - 8),
    directive: "Sing every exact lyric word once. Start on the first beat within one second " +
      "and finish all singing by 25 seconds. Use no ad-libs, repetitions or substitutions.",
  };
}
