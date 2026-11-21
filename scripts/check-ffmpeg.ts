import { audioHealth } from "../server/audioHealth.ts";
import { ffmpegCapabilities } from "../server/ffmpeg.ts";

const { ffmpeg_path, message } = await ffmpegCapabilities();
const health = await audioHealth();
console.info(JSON.stringify({ event: "ffmpeg_build_check", ffmpeg_path, ...health, message }));
if (!health.ffmpeg_master_test) process.exitCode = 1;
