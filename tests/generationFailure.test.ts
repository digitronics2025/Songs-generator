import { afterEach, describe, expect, it, vi } from "vitest";
import { MasteringError } from "../server/audio.ts";
import { logGenerationFailure } from "../server/generationFailure.ts";
import { decideRepairAction } from "../src/lib/songRepair.ts";
import { INITIAL_SONGS } from "../src/data/songs.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("generation failure diagnostics", () => {
  it("writes one structured line with the real mastering stage and a bounded message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const localKey = "local-test-gemini-value";
    vi.stubEnv("GEMINI_API_KEY", localKey);
    const error = new MasteringError("master_pass2", Object.assign(new Error("Command failed"), {
      code: "EACCES",
      stderr: "Decoder failed.\nBearer private-token " + localKey +
        " https://example.test/raw.mp3?X-Goog-Signature=signature " + "a".repeat(600),
    }));
    const detail = logGenerationFailure("song-a", "take-a", "master_pass1", error);
    const entry = JSON.parse(String(log.mock.calls[0][0]));
    expect(log).toHaveBeenCalledTimes(1);
    expect(entry).toMatchObject({
      event: "generation_failed", song_id: "song-a", take_id: "take-a", stage: "master_pass2",
      error_name: "Error", error_code: "EACCES", message: expect.stringContaining("Decoder failed."),
    });
    expect(entry.message.length).toBeLessThanOrEqual(500);
    expect(detail).toEqual({ stage: "master_pass2", message: entry.message.slice(0, 180) });
    expect(String(log.mock.calls[0][0])).not.toMatch(/private-token|signature|example\.test|local-test-gemini-value/);
  });
});

describe("saved audio recovery", () => {
  it("recovers raw audio from old failed takes even without a recorded stage and leaves approved takes alone", () => {
    const raw = {
      storage_path: null, raw_storage_path: "songs/takes/song-a/take-a-source.mp3", status: "failed",
      duration_seconds: null, lufs: null, true_peak_db: null, voice_start: null, voice_end: null,
      words_heard_pct: null, missing_words: [], extra_words: [],
    };
    expect(decideRepairAction(INITIAL_SONGS[0], [raw])).toMatchObject({
      type: "REMASTER", source: "raw", takeIndex: 0,
    });
    expect(decideRepairAction(INITIAL_SONGS[0], [{ ...raw, is_approved: true }]).type).not.toBe("REMASTER");
    expect(decideRepairAction(INITIAL_SONGS[0], [{
      ...raw, storage_path: "songs/takes/song-a/take-a.wav", vocal_check_pending: true,
    }]).type).toBe("AWAIT_VOCALS");
  });
});
