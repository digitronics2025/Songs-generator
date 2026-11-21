import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GenerationStage } from "../src/lib/songRepair.ts";
import type { FfmpegRunner } from "./ffmpegProcess.ts";

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

export async function masterWavWith(run: FfmpegRunner, input: Buffer, targetLength: number, repair = false) {
  let stage: MasteringError["stage"] = "master_pass1";
  try {
    return await scratch(input, async (source, dir) => {
      const output = join(dir, "master.wav");
      const peak = repair ? -1.8 : -1.4;
      const normalization = "loudnorm=I=-14:TP=" + peak + ":LRA=7";
      const trim = "atrim=end=" + targetLength + ",asetpts=PTS-STARTPTS";
      const format = input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WAVE" ? "wav" : "mp3";
      const common = ["-protocol_whitelist", "file", "-f", format, "-i", source, "-map", "0:a:0"];
      const first = await run("master_pass1", [...common, "-af", trim + "," + normalization + ":print_format=json", "-f", "null", "-"]);
      const m = loudness(first.stderr);
      const filter = [
        normalization, "measured_I=" + m.input_i, "measured_TP=" + m.input_tp,
        "measured_LRA=" + m.input_lra, "measured_thresh=" + m.input_thresh,
        "offset=" + m.target_offset, "linear=true",
      ].join(":");

      stage = "master_pass2";
      await run("master_pass2", [...common, "-af", trim + "," + filter, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", output]);

      stage = "master_measure";
      const measured = await run("master_measure", ["-i", output, "-af", normalization + ":print_format=json", "-f", "null", "-"]);
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

export function encodeMp3With(run: FfmpegRunner, wav: Buffer) {
  return scratch(wav, async (source, dir) => {
    const output = join(dir, "studio.mp3");
    await run("encode_mp3", ["-protocol_whitelist", "file", "-f", "wav", "-i", source, "-vn",
      "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", output]);
    return readFile(output);
  });
}

function silenceAndTone() {
  const rate = 44_100;
  const wav = Buffer.alloc(44 + rate * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(rate * 2, 40);
  for (let frame = rate / 5; frame < rate; frame++) {
    wav.writeInt16LE(Math.round(4_000 * Math.sin(2 * Math.PI * 440 * frame / rate)), 44 + frame * 2);
  }
  return wav;
}

export async function testMastering(run: FfmpegRunner) {
  const input = await encodeMp3With(run, silenceAndTone());
  const { duration_seconds, lufs, true_peak_db } = await masterWavWith(run, input, 1);
  if (Math.abs(duration_seconds - 1) > 0.02 || lufs < -15 || lufs > -13 || true_peak_db > -1) {
    throw new Error("The synthetic mastering test produced unexpected measurements.");
  }
}
