import { ffmpegHealth } from "./ffmpeg.ts";

export async function audioHealth() {
  const { ffmpeg_path, ...health } = await ffmpegHealth();
  void ffmpeg_path; // Executable paths are confined to startup/build logs.
  return health;
}

export async function logFfmpegStartup() {
  console.info(JSON.stringify({ event: "ffmpeg_startup", ...await ffmpegHealth() }));
}
