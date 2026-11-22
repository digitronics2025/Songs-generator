import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO_SETTINGS, INITIAL_SONGS, PREVIOUS_SEED_LINES } from "../src/data/songs.ts";
import { normalizeArabicText, validateLyrics, compareTranscriptInOrder } from "../src/lib/lyricQuality.ts";
import { closestLyric } from "../src/lib/duplicates.ts";
import { countStatuses } from "../src/lib/catalogState.ts";
import { historyRecord, legacyTakes, migrationPatch, migrateStatus } from "../server/migration.ts";
import { checkBudget, checkGenerationLimits } from "../server/limits.ts";
import { ownsLease } from "../server/generation.ts";
import { audioFailures, canRetryProvider, decideRepairAction, repeatedExtras } from "../src/lib/songRepair.ts";

describe("lyric rules", () => {
  it.each(INITIAL_SONGS)("passes the supplied seed for song $number", ({ lines }) => {
    expect(validateLyrics(lines, DEFAULT_STUDIO_SETTINGS)).toEqual({ valid: true, errors: [] });
  });
  it.each(INITIAL_SONGS)("uses distinct paired rhyme endings in song $number", ({ lines }) => {
    const endings = lines.map(line => normalizeArabicText(line).split(" ").at(-1)!);
    for (let i = 0; i < endings.length; i += 2) {
      expect(endings[i]).not.toBe(endings[i + 1]);
      expect(endings[i].slice(-2)).toEqual(endings[i + 1].slice(-2));
    }
  });
  it("retains a distinct original lyric for every seed", () => {
    expect(Object.keys(PREVIOUS_SEED_LINES)).toHaveLength(20);
    for (const song of INITIAL_SONGS) {
      expect(PREVIOUS_SEED_LINES[song.number]).toHaveLength(6);
      expect(PREVIOUS_SEED_LINES[song.number]).not.toEqual(song.lines);
    }
  });
  it("rejects off-count lines, digits, brands, and forbidden forms", () => {
    const errors = validateLyrics(["ونتا كتشري واتساب ٣ دراهم", "فرحت بلمة", "ليل ونهار"]).errors.join(" ");
    expect(errors).toMatch(/exactly.*digits.*واتساب.*لمة.*phrase/);
  });
  it("compares in order and detects extra repetitions", () => {
    const comparison = compareTranscriptInOrder(["طحت مرة ومرة", "بابا قال لي نوض"], "طحت مرة مرة بابا قال لي نوض");
    expect(comparison.missing_words).toEqual(["ومرة"]);
    expect(repeatedExtras(comparison.extra_words, ["طحت مرة ومرة"])).toEqual(["مرة"]);
  });
});

describe("duplicate checks", () => {
  it("normalizes Arabic marks, punctuation and letter variants", () => {
    expect(normalizeArabicText(" أَحلى، إِجابةٌ! ")).toBe("احلي اجابه");
  });
  const original = { title: "دار جدتي", lines: ["دار جدتي دافية", "الخبز سخون فالفران", "التراب شتا الخير"] };
  it("blocks a normalized title, any duplicate line and a trigram inside a line", () => {
    expect(closestLyric({ title: "دَار جَدّتي!", lines: ["سيدي جالس"] }, [original]).rejected).toBe(true);
    expect(closestLyric({ title: "مطر", lines: ["الخبز سخون فالفران"] }, [original]).rejected).toBe(true);
    expect(closestLyric({ title: "مطر", lines: ["الخبز سخون فالفران والفرحة", "باب جديد مفتوح بقلبي"] }, [original]).rejected).toBe(true);
  });
  it("uses strict overlap and embedding thresholds", () => {
    const ref = { title: "سيدي", lines: ["باب ظل حيط صبح دار"], embedding: [1, 0] };
    expect(closestLyric({ title: "ميمة", lines: ["باب مرحبا دار سوق خير"], embedding: [0, 1] }, [ref]))
      .toEqual({ rejected: false, closest_match_pct: 40 });
    expect(closestLyric({ title: "ميمة", lines: ["باب مرحبا دار سوق صبح"] }, [ref]).rejected).toBe(true);
    expect(closestLyric({ title: "ميمة", lines: ["سوق عامر بالمحبة"], embedding: [0.9, 0.1] }, [ref]).rejected).toBe(true);
  });
});

describe("catalog migration", () => {
  it("maps legacy states and counts unrecognized states without hiding songs", () => {
    expect(migrateStatus("pending", true)).toBe("draft");
    expect(migrateStatus("ready", true)).toBe("ready");
    expect(migrateStatus("error", false)).toBe("failed");
    const counts = countStatuses([{ status: "old", archived: false }, { status: "ready", archived: false },
      { status: "archived", archived: false }, { status: "all", archived: false }]);
    expect(counts).toMatchObject({ all: 3, ready: 1, archived: 1, other: 2 });
  });
  it("retains old audio while replacing lyrics and fixing the feeling", () => {
    const old = { number: 1, status: "approved", admin_feeling: "family_evening", title: "قديم", lines: ["قديم"],
      feeling_key: "mothers_prayers", storage_path: "songs/01-mothers_prayers.wav", file_name: "custom.wav" };
    const [take] = legacyTakes(old, "date");
    const patch = migrationPatch("1", old, "date", take);
    expect({ ...old, ...patch }).toMatchObject({ ...INITIAL_SONGS[0], ...old,
      title: INITIAL_SONGS[0].title, lines: INITIAL_SONGS[0].lines, admin_feeling: "mothers_care", status: "ready" });
    expect(take).toMatchObject({ is_approved: true, storage_path: old.storage_path });
    expect(historyRecord("h", "1", old, "migrated", "date").title).toBe("قديم");
  });
});

describe("server limits", () => {
  it("blocks an active lock, fences expired workers, and allows reclaim", () => {
    expect(() => checkGenerationLimits({ expires_at: 11 }, 0, 0, 10)).toThrow(/already generating/);
    expect(() => checkGenerationLimits({ expires_at: 10 }, 3, 1, 10)).not.toThrow();
    expect(ownsLease({ token: "new", expires_at: 12 }, "old", 10)).toBe(false);
    expect(ownsLease({ token: "new", expires_at: 10 }, "new", 10)).toBe(false);
    expect(ownsLease({ token: "new", expires_at: 12 }, "new", 10)).toBe(true);
  });
  it("enforces take ceilings and exact integer budget limits", () => {
    expect(() => checkGenerationLimits(undefined, 4, 0, 1)).toThrow(/take limit/);
    expect(() => checkGenerationLimits(undefined, 3, 2, 1)).toThrow(/automatic/);
    expect(() => checkBudget(80_000, 40_000, 120_000)).not.toThrow();
    expect(() => checkBudget(80_001, 40_000, 120_000)).toThrow(/budget/);
  });
});

describe("repair decisions", () => {
  const song = INITIAL_SONGS[0];
  const pass = { storage_path: "songs/test.wav", duration_seconds: 30, words_heard_pct: 100,
    voice_start: 0, voice_end: 27, lufs: -14, true_peak_db: -1,
    missing_words: [], extra_words: [] };
  it("measures exact boundaries and refuses unknown metrics", () => {
    expect(audioFailures(pass)).toEqual([]);
    expect(audioFailures({ ...pass, voice_start: null, voice_end: 27.01 })).toEqual(["VOICE_START", "VOICE_END"]);
  });
  it("picks remaster, new take, lyric review and no-op appropriately", () => {
    expect(decideRepairAction(song, [pass]).type).toBe("NONE");
    expect(decideRepairAction(song, [{ ...pass, lufs: -12 }]).type).toBe("REMASTER");
    expect(decideRepairAction(song, [{ ...pass, voice_end: 28 }]).type).toBe("NEW_TAKE");
    const missed = { ...pass, words_heard_pct: 80, missing_words: ["بابا"] };
    expect(decideRepairAction(song, [missed, missed]).type).toBe("REQUEST_LYRIC_FIX");
    expect(decideRepairAction({ ...song, lines: [] }, [pass]).type).toBe("REQUEST_LYRIC_FIX");
  });
  it("retries only transient provider failures", () => {
    expect([400, 401, 403, 404, 429, 503, 504].map(canRetryProvider)).toEqual([false, false, false, false, true, true, true]);
  });
});
