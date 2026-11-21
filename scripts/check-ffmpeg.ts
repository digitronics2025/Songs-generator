import { ffmpegHealth } from "../server/ffmpeg.ts";

const health = await ffmpegHealth();
console.info(JSON.stringify({ event: "ffmpeg_build_check", ...health }));
if (!health.ffmpeg_master_test) process.exitCode = 1;
