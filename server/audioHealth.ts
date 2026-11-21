import { encodeMp3, masterWav } from "./audio.ts";
import { ffmpegCapabilities } from "./ffmpeg.ts";

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

async function inspectAudio() {
  const { ffmpeg_present, ffmpeg_version, loudnorm, libmp3lame } = await ffmpegCapabilities();
  let ffmpeg_master_test = false;
  if (ffmpeg_present && loudnorm && libmp3lame) {
    try {
      const input = await encodeMp3(silenceAndTone());
      const { duration_seconds, lufs, true_peak_db } = await masterWav(input, 1);
      ffmpeg_master_test = Math.abs(duration_seconds - 1) <= 0.02 &&
        lufs >= -15 && lufs <= -13 && true_peak_db <= -1;
    } catch {
      // The probe has no user data; report unavailability through the boolean.
    }
  }
  return { ffmpeg_present, ffmpeg_version, loudnorm, libmp3lame, ffmpeg_master_test };
}

let audioProbe: { override: string | undefined; result: ReturnType<typeof inspectAudio> } | undefined;

export function audioHealth() {
  const override = process.env.FFMPEG_PATH;
  if (!audioProbe || audioProbe.override !== override) audioProbe = { override, result: inspectAudio() };
  return audioProbe.result;
}

export async function logFfmpegStartup() {
  const { ffmpeg_path, message } = await ffmpegCapabilities();
  console.info(JSON.stringify({ event: "ffmpeg_startup", ffmpeg_path, ...await audioHealth(), message }));
}
