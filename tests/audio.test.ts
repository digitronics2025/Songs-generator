import { describe, expect, it } from "vitest";
import { encodeMp3, masterWav } from "../server/audio.ts";

function tone() {
  const sampleRate = 22_050;
  const frames = sampleRate * 30;
  const bytes = new Uint8Array(44 + frames * 2);
  const pcm = Buffer.from(bytes.buffer);
  pcm.write("RIFF", 0);
  pcm.writeUInt32LE(pcm.length - 8, 4);
  pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(sampleRate, 24);
  pcm.writeUInt32LE(sampleRate * 2, 28);
  pcm.writeUInt16LE(2, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36);
  pcm.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), 44 + i * 2);
  }
  return pcm;
}

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
  }, 25_000);
});
