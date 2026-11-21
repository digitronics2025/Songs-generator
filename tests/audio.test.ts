import { describe, expect, it } from "vitest";
import { encodeMp3, masterWav } from "../server/ffmpeg.ts";

import { tone } from "./audioFixture.ts";

describe("FFmpeg output", () => {
  it("measures the mastered PCM and encodes 44.1 kHz stereo 128 kbps CBR MP3", async () => {
    const master = await masterWav(tone(), 30);
    expect(master.duration_seconds).toBeCloseTo(30, 2);
    expect(master.lufs).toBeGreaterThanOrEqual(-15);
    expect(master.lufs).toBeLessThanOrEqual(-13);
    expect(master.true_peak_db).toBeLessThanOrEqual(-1);
    expect(master.wav.readUInt32LE(24)).toBe(44_100);
    expect(master.wav.readUInt16LE(22)).toBe(2);

    const mp3 = await encodeMp3(master.wav);
    expect(mp3.length).toBeGreaterThan(475_000);
    expect(mp3.length).toBeLessThan(485_000);
    const frame = mp3.indexOf(Buffer.from([0xff, 0xfb]));
    expect(frame).toBeGreaterThanOrEqual(0);
    expect(mp3[frame + 2] >> 4).toBe(9); // MPEG-1 Layer III 128 kbps.
    expect(mp3[frame + 2] & 0x0c).toBe(0); // MPEG-1 44.1 kHz.
    expect(mp3[frame + 3] & 0xc0).not.toBe(0xc0); // Stereo, including joint stereo.

    // Exercise the real Lyria input format through the bundled decoder and mastering passes.
    const fromMp3 = await masterWav(mp3, 30, true);
    expect(fromMp3.duration_seconds).toBeCloseTo(30, 2);
    expect(fromMp3.lufs).toBeGreaterThanOrEqual(-15);
    expect(fromMp3.lufs).toBeLessThanOrEqual(-13);
    expect(fromMp3.true_peak_db).toBeLessThanOrEqual(-1);
  }, 25_000);

  it("attributes a malformed local MP3 to the first mastering pass", async () => {
    await expect(masterWav(Buffer.from("invalid MP3 fixture"), 30)).rejects.toMatchObject({ stage: "master_pass1" });
  });
});
