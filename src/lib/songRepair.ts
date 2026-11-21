import { normalizeArabicText, validateLyrics } from "./lyricQuality";
import type { SongState } from "../data/songs";

export const FAILURE_CODES = {
  API_ERROR: "API_ERROR",
  RATE_LIMIT_429: "RATE_LIMIT_429",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  TIMEOUT: "TIMEOUT",
  LOUDNESS_FAILURE: "LOUDNESS_FAILURE",
  PEAK_FAILURE: "PEAK_FAILURE",
  WORDS_HEARD_LOW: "WORDS_HEARD_LOW",
  EXTRA_WORDS: "EXTRA_WORDS",
  VOICE_LATE: "VOICE_LATE",
  VOICE_TOO_LONG: "VOICE_TOO_LONG",
  LENGTH_INVALID: "LENGTH_INVALID",
  LYRIC_RULE_FAILURE: "LYRIC_RULE_FAILURE",
  PERSISTENT_MISSING_WORD: "PERSISTENT_MISSING_WORD",
} as const;

export type FailureCode = (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES];

export interface SongTake {
  id: string; // e.g. "take-1", "take-2"
  take_number: number;
  created_at: string;
  model_used: string;
  file_name: string;
  storage_path: string | null;
  download_url: string | null;
  duration_seconds: number | null;
  lufs: number | null;
  true_peak_db: number | null;
  words_heard_pct: number | null;
  transcribed_text: string | null;
  missing_words: string[];
  extra_words: string[];
  voice_start_seconds: number | null;
  voice_end_seconds: number | null;
  passed_all_checks: boolean;
  failure_reasons: string[];
  is_best: boolean;
  is_approved: boolean;
  tempo_bpm: number;
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

export interface QualityCheckDetail {
  passed: boolean;
  failure_codes: FailureCode[];
  reasons: string[];
  persistent_word?: string;
  is_loudness_or_peak_only: boolean;
}

export function detectRepeatedWords(transcribedText: string): string[] {
  const norm = normalizeArabicText(transcribedText);
  if (!norm) return [];
  const words = norm.split(" ").filter(Boolean);
  const repeated: string[] = [];
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1] && words[i].length > 1) {
      repeated.push(words[i]);
    }
  }
  return Array.from(new Set(repeated));
}

export function checkPersistentMissingWord(
  takes: Array<{ missing_words?: string[] }>
): string | null {
  if (takes.length < 2) return null;
  const lastTake = takes[takes.length - 1];
  const prevTake = takes[takes.length - 2];
  if (!lastTake?.missing_words || !prevTake?.missing_words) return null;

  const prevNorm = new Set(prevTake.missing_words.map((w) => normalizeArabicText(w)));
  for (const word of lastTake.missing_words) {
    const norm = normalizeArabicText(word);
    if (norm && prevNorm.has(norm)) {
      return word;
    }
  }
  return null;
}

export function runFullSongQualityChecks(
  song: SongState,
  currentAudio?: {
    duration_seconds: number | null;
    lufs: number | null;
    true_peak_db: number | null;
    words_heard_pct: number | null;
    transcribed_text: string | null;
    missing_words: string[];
    extra_words: string[];
    voice_start_seconds: number | null;
    voice_end_seconds: number | null;
  }
): QualityCheckDetail {
  const failure_codes: FailureCode[] = [];
  const reasons: string[] = [];

  // Check 1: Lyric rules
  const lyricCheck = validateLyrics(song.lines);
  if (!lyricCheck.valid) {
    failure_codes.push(FAILURE_CODES.LYRIC_RULE_FAILURE);
    reasons.push(`Lyric rules not met: ${lyricCheck.errors.join("; ")}`);
  }

  const duration = currentAudio ? currentAudio.duration_seconds : song.duration_seconds;
  const lufs = currentAudio ? currentAudio.lufs : song.lufs;
  const peak = currentAudio ? currentAudio.true_peak_db : song.true_peak_db;
  const wordsPct = currentAudio ? currentAudio.words_heard_pct : song.words_heard_pct;
  const transcript = currentAudio ? currentAudio.transcribed_text : song.transcribed_text;
  const extraWords = currentAudio ? currentAudio.extra_words : song.extra_words;
  const voiceStart = currentAudio ? currentAudio.voice_start_seconds : song.voice_start_seconds;
  const voiceEnd = currentAudio ? currentAudio.voice_end_seconds : song.voice_end_seconds;

  // Check 2: Words heard % (>= 90%)
  if (typeof wordsPct === "number" && wordsPct < 90) {
    failure_codes.push(FAILURE_CODES.WORDS_HEARD_LOW);
    reasons.push(`Words heard ${wordsPct}% is below 90% target`);
  }

  // Check 3: Extra or repeated words
  const repeated = transcript ? detectRepeatedWords(transcript) : [];
  if ((extraWords && extraWords.length > 0) || repeated.length > 0) {
    failure_codes.push(FAILURE_CODES.EXTRA_WORDS);
    const msg = [
      extraWords && extraWords.length > 0 ? `Extra words (${extraWords.join(", ")})` : "",
      repeated.length > 0 ? `Repeated words (${repeated.join(", ")})` : "",
    ]
      .filter(Boolean)
      .join(" & ");
    reasons.push(msg);
  }

  // Check 4: Voice start (<= 1.0 s)
  if (typeof voiceStart === "number" && voiceStart > 1.0) {
    failure_codes.push(FAILURE_CODES.VOICE_LATE);
    reasons.push(`Voice started late at ${voiceStart.toFixed(1)}s (must be ≤ 1.0s)`);
  }

  // Check 5: Voice end (<= 27.0 s)
  if (typeof voiceEnd === "number" && voiceEnd > 27.0) {
    failure_codes.push(FAILURE_CODES.VOICE_TOO_LONG);
    reasons.push(`Voice ended late at ${voiceEnd.toFixed(1)}s (must be ≤ 27.0s)`);
  }

  // Check 6: Audio length (30-45 s)
  if (typeof duration === "number" && (duration < 28 || duration > 45)) {
    failure_codes.push(FAILURE_CODES.LENGTH_INVALID);
    reasons.push(`Audio duration ${duration.toFixed(1)}s is outside 30-45s broadcast spec`);
  }

  // Check 7: LUFS (-14 ± 1, i.e. between -15.0 and -13.0)
  if (typeof lufs === "number" && (lufs < -15.0 || lufs > -13.0)) {
    failure_codes.push(FAILURE_CODES.LOUDNESS_FAILURE);
    reasons.push(`Loudness ${lufs.toFixed(1)} LUFS outside target (-14 ± 1 LUFS)`);
  }

  // Check 8: True peak (<= -1.0 dBTP)
  if (typeof peak === "number" && peak > -1.0) {
    failure_codes.push(FAILURE_CODES.PEAK_FAILURE);
    reasons.push(`True peak ${peak.toFixed(1)} dBTP exceeds limit (≤ -1.0 dBTP)`);
  }

  // Check 9: Persistent missing word across takes
  const takes = song.takes || [];
  const persistent = checkPersistentMissingWord(takes);
  if (persistent) {
    failure_codes.push(FAILURE_CODES.PERSISTENT_MISSING_WORD);
    reasons.push(`Same word "${persistent}" missed in consecutive takes`);
  }

  const is_loudness_or_peak_only =
    failure_codes.length > 0 &&
    failure_codes.every(
      (code) => code === FAILURE_CODES.LOUDNESS_FAILURE || code === FAILURE_CODES.PEAK_FAILURE
    );

  return {
    passed: failure_codes.length === 0,
    failure_codes,
    reasons,
    persistent_word: persistent ?? undefined,
    is_loudness_or_peak_only,
  };
}

export type RepairAction =
  | { type: "NONE" }
  | { type: "NEEDS_PERSON"; reason: string }
  | { type: "REQUEST_LYRIC_FIX"; reason: string; failingWords?: string[] }
  | { type: "REMASTER"; reason: string }
  | { type: "NEW_TAKE"; reason: string; newTempoBpm: number; promptDirective: string }
  | { type: "RETRY_API"; backoffMs: number; switchModel?: boolean; reason: string };

export function decideRepairAction(
  song: SongState,
  options: {
    spentTodayUsd: number;
    dailyBudgetUsd: number;
    todayDateStr: string;
    apiErrorDetails?: {
      status?: number;
      message?: string;
      retryCount?: number;
    };
  }
): RepairAction {
  const { spentTodayUsd, dailyBudgetUsd, todayDateStr, apiErrorDetails } = options;

  // 1. API error handling branch
  if (apiErrorDetails) {
    const isModelNotFound =
      apiErrorDetails.status === 404 ||
      apiErrorDetails.message?.toLowerCase().includes("not found");
    const retryCount = apiErrorDetails.retryCount ?? 0;

    if (isModelNotFound) {
      return {
        type: "RETRY_API",
        backoffMs: 2000,
        switchModel: true,
        reason: "Model 404 not found: switching between lyria-3.5 and lyria-3-clip-preview",
      };
    }

    if (retryCount >= 3) {
      return {
        type: "NEEDS_PERSON",
        reason: `API errors persisted after 3 retries (${apiErrorDetails.message || "Timeout/5xx/429"})`,
      };
    }

    // Schedule: 30s, 2 min, 10 min
    const backoffs = [30_000, 120_000, 600_000];
    const waitMs = backoffs[Math.min(retryCount, backoffs.length - 1)];
    return {
      type: "RETRY_API",
      backoffMs: waitMs,
      reason: `API failure (HTTP ${apiErrorDetails.status || "network"}). Retry #${retryCount + 1} scheduled in ${Math.round(waitMs / 1000)}s`,
    };
  }

  // 2. Run all quality checks
  const check = runFullSongQualityChecks(song);
  if (check.passed) {
    return { type: "NONE" };
  }

  // 3. Priority check: Lyric rule failure or persistent missing word requires Gemini lyric rewrite
  if (
    check.failure_codes.includes(FAILURE_CODES.LYRIC_RULE_FAILURE) ||
    check.failure_codes.includes(FAILURE_CODES.PERSISTENT_MISSING_WORD)
  ) {
    return {
      type: "REQUEST_LYRIC_FIX",
      reason: check.reasons.join(" | "),
      failingWords: check.persistent_word ? [check.persistent_word] : song.missing_words,
    };
  }

  // 4. Loudness or Peak failure only -> Re-master the same audio! No new generation!
  if (check.is_loudness_or_peak_only) {
    return {
      type: "REMASTER",
      reason: check.reasons.join(" | "),
    };
  }

  // 5. Safety limit checks before generating a new audio take
  const takes = song.takes || [];
  if (takes.length >= 4) {
    return {
      type: "NEEDS_PERSON",
      reason: "Maximum take limit reached (4 takes). Person review required.",
    };
  }

  const lastDate = song.last_take_date;
  const currentDailyTakes = lastDate === todayDateStr ? (song.automatic_takes_today ?? 0) : 0;
  if (currentDailyTakes >= 2) {
    return {
      type: "NEEDS_PERSON",
      reason: `Daily automatic take limit reached (2 takes/day). Person review required.`,
    };
  }

  const estimatedTakeCost = 0.08;
  if (spentTodayUsd + estimatedTakeCost > dailyBudgetUsd) {
    return {
      type: "NEEDS_PERSON",
      reason: `Daily budget reached ($${spentTodayUsd.toFixed(2)} / $${dailyBudgetUsd.toFixed(2)}). Person review required.`,
    };
  }

  // 6. Generate new take with corrected prompt & tempo
  const adjustedTempo = Math.max(70, Math.min(100, Math.round(song.tempo_bpm - 8)));
  const promptDirective =
    "sing every word slowly and clearly, each line once only, no repeats, voice finished by 25 seconds";

  return {
    type: "NEW_TAKE",
    reason: check.reasons.join(" | "),
    newTempoBpm: adjustedTempo,
    promptDirective,
  };
}

export function scoreTake(take: SongTake): number {
  if (take.is_approved) return 1_000_000;
  let score = 0;
  if (take.passed_all_checks) score += 10_000;
  if (take.words_heard_pct !== null) score += take.words_heard_pct * 10;
  if (take.voice_start_seconds !== null && take.voice_start_seconds <= 1.0) score += 500;
  if (take.voice_end_seconds !== null && take.voice_end_seconds <= 27.0) score += 500;
  if (take.lufs !== null) {
    const lufsDiff = Math.abs(take.lufs - -14.0);
    score += Math.max(0, 500 - lufsDiff * 100);
  }
  if (take.true_peak_db !== null && take.true_peak_db <= -1.0) score += 300;
  return score;
}

export function pickBestTakeId(takes: SongTake[]): string | null {
  if (takes.length === 0) return null;
  const approved = takes.find((t) => t.is_approved);
  if (approved) return approved.id;

  let best = takes[0];
  let bestScore = scoreTake(best);
  for (let i = 1; i < takes.length; i++) {
    const s = scoreTake(takes[i]);
    if (s > bestScore) {
      best = takes[i];
      bestScore = s;
    }
  }
  return best.id;
}
