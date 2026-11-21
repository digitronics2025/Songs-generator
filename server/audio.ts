import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GenerationStage } from "../src/lib/songRepair.ts";
import { runFfmpeg } from "./ffmpeg.ts";

const maxAudio = 25 * 1024 * 1024;

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
  const parsed = stats.safeParse(match ? JSON.parse(match[0]) : null);
  if (!parsed.success) throw new Error("FFmpeg did not report finite loudness measurements.");
  return parsed.data;
}

export class MasteringError extends Error {
  constructor(readonly stage: Extract<GenerationStage, "master_pass1" | "master_pass2" | "master_measure">, cause: unknown) {
    super("FFmpeg mastering failed at " + stage + ".", { cause });
  }
}

export async function masterWav(input: Buffer, targetLength: number, repair = false) {
  let stage: MasteringError["stage"] = "master_pass1";
  try {
    return await scratch(input, async (source, dir) => {
      const output = join(dir, "master.wav");
      const peak = repair ? -1.8 : -1.4;
      const normalization = "loudnorm=I=-14:TP=" + peak + ":LRA=7";
      const trim = "atrim=end=" + targetLength + ",asetpts=PTS-STARTPTS";
      const format = input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WAVE" ? "wav" : "mp3";
      const common = ["-protocol_whitelist", "file", "-f", format, "-i", source, "-map", "0:a:0"];
      const first = await runFfmpeg([...common, "-af", trim + "," + normalization + ":print_format=json", "-f", "null", "-"]);
      const m = loudness(first.stderr);
      const filter = [
        normalization, "measured_I=" + m.input_i, "measured_TP=" + m.input_tp,
        "measured_LRA=" + m.input_lra, "measured_thresh=" + m.input_thresh,
        "offset=" + m.target_offset, "linear=true",
      ].join(":");

      stage = "master_pass2";
      await runFfmpeg([...common, "-af", trim + "," + filter, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", output]);

      stage = "master_measure";
      const measured = await runFfmpeg(["-i", output, "-af", normalization + ":print_format=json", "-f", "null", "-"]);
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
  } catch (error) {
    throw new MasteringError(stage, error);
  }
}

export function encodeMp3(wav: Buffer) {
  return scratch(wav, async (source, dir) => {
    const output = join(dir, "studio.mp3");
    await runFfmpeg(["-protocol_whitelist", "file", "-f", "wav", "-i", source, "-vn",
      "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", output]);
    return readFile(output);
  });
}
