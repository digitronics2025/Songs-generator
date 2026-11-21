import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { z } from "zod";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || (ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : "ffmpeg");
const maxAudio = 25 * 1024 * 1024;

async function transcode(args: string[]) {
  return run(ffmpeg, ["-nostdin", "-hide_banner", "-y", ...args], { timeout: 25_000, maxBuffer: 1024 * 1024 });
}

async function scratch<T>(input: Buffer, convert: (source: string, dir: string) => Promise<T>) {
  if (!input.length || input.length > maxAudio) throw new Error("Audio size is out of bounds.");
  const dir = await mkdtemp(join(tmpdir(), "darija-audio-"));
  try {
    const source = join(dir, "source");
    await writeFile(source, input);
    return await convert(source, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const stats = z.object({
  input_i: z.coerce.number().finite(), input_tp: z.coerce.number().finite(),
  input_lra: z.coerce.number().finite(), input_thresh: z.coerce.number().finite(),
  target_offset: z.coerce.number().finite(),
});
function loudness(output: string) {
  const match = output.match(/\{\s*"input_i"\s*:[\s\S]*?\}/);
  return stats.parse(match ? JSON.parse(match[0]) : null);
}

export function masterWav(input: Buffer, targetLength: number, repair = false) {
  return scratch(input, async (source, dir) => {
    const output = join(dir, "master.wav");
    const peak = repair ? -1.8 : -1.4;
    const normalization = "loudnorm=I=-14:TP=" + peak + ":LRA=7";
    const trim = "atrim=end=" + targetLength + ",asetpts=PTS-STARTPTS";
    const common = ["-protocol_whitelist", "file", "-i", source, "-vn", "-sn", "-dn"];
    const first = await transcode([...common, "-af", trim + "," + normalization + ":print_format=json", "-f", "null", "-"]);
    const m = loudness(first.stderr);
    const filter = [
      normalization, "measured_I=" + m.input_i, "measured_TP=" + m.input_tp,
      "measured_LRA=" + m.input_lra, "measured_thresh=" + m.input_thresh,
      "offset=" + m.target_offset, "linear=true",
    ].join(":");
    await transcode([...common, "-af", trim + "," + filter, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", output]);
    const measured = await transcode(["-i", output, "-af", normalization + ":print_format=json", "-f", "null", "-"]);
    const final = loudness(measured.stderr);
    const wav = await readFile(output);
    let dataLength = 0;
    for (let offset = 12; offset + 8 <= wav.length;) {
      const size = wav.readUInt32LE(offset + 4);
      if (wav.toString("ascii", offset, offset + 4) === "data") {
        dataLength = Math.min(size, wav.length - offset - 8);
        break;
      }
      offset += 8 + size + size % 2;
    }
    const duration_seconds = dataLength / (44_100 * 4);
    if (!Number.isFinite(duration_seconds) || duration_seconds <= 0 || duration_seconds > 44.1) {
      throw new Error("Mastered WAV duration is invalid.");
    }
    return { wav, duration_seconds, lufs: final.input_i, true_peak_db: final.input_tp };
  });
}

export function encodeMp3(wav: Buffer) {
  return scratch(wav, async (source, dir) => {
    const output = join(dir, "studio.mp3");
    await transcode(["-protocol_whitelist", "file", "-f", "wav", "-i", source, "-vn",
      "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", output]);
    return readFile(output);
  });
}
