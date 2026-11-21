import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { diagnosticMessage } from "./firebaseErrors.ts";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

export function resolveFfmpeg(override = process.env.FFMPEG_PATH) {
  const configured = override?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("FFMPEG_PATH must be an absolute executable path.");
    return configured;
  }
  const filename = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const name = "@seydx/node-av-ffmpeg-lgpl-" + process.platform + "-" + process.arch;
  const cliRequire = createRequire(require.resolve("@seydx/node-av-ffmpeg-lgpl/package.json"));
  try {
    return cliRequire.resolve(name + "/" + filename);
  } catch (cause) {
    if (process.platform === "linux") {
      try { return cliRequire.resolve(name + "-musl/" + filename); }
      catch { /* The installed image has no matching binary. */ }
    }
    throw new Error("Bundled FFmpeg is missing for " + process.platform + "/" + process.arch +
      ". Install the platform's npm optional dependencies.", { cause });
  }
}

export function runFfmpeg(args: string[]) {
  return exec(resolveFfmpeg(), ["-nostdin", "-hide_banner", "-nostats", "-y", ...args], {
    timeout: 25_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

async function inspectFfmpeg(override?: string) {
  let ffmpeg_path: string | null = null;
  let ffmpeg_version: string | null = null;
  try {
    ffmpeg_path = resolveFfmpeg(override);
    const args = { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true };
    const version = await exec(ffmpeg_path, ["-version"], args);
    ffmpeg_version = /^ffmpeg version ([\w.+-]{1,100})(?:\s|$)/im.exec(version.stdout)?.[1] ?? null;
    if (!ffmpeg_version) throw new Error("The executable did not report an FFmpeg version.");
    const [filters, encoders] = await Promise.all([
      exec(ffmpeg_path, ["-hide_banner", "-filters"], args),
      exec(ffmpeg_path, ["-hide_banner", "-encoders"], args),
    ]);
    return {
      ffmpeg_path, ffmpeg_version, ffmpeg_present: true,
      loudnorm: /^\s*[A-Z.]+\s+loudnorm\s/m.test(filters.stdout),
      libmp3lame: /^\s*A[A-Z.]+\s+libmp3lame\s/m.test(encoders.stdout),
      message: null,
    };
  } catch (error) {
    return { ffmpeg_path, ffmpeg_version, ffmpeg_present: ffmpeg_version !== null,
      loudnorm: false, libmp3lame: false,
      message: diagnosticMessage(error instanceof Error ? error.message : "FFmpeg could not be started.") };
  }
}

let probe: { override: string | undefined; result: ReturnType<typeof inspectFfmpeg> } | undefined;

export function ffmpegCapabilities() {
  const override = process.env.FFMPEG_PATH;
  if (!probe || probe.override !== override) probe = { override, result: inspectFfmpeg(override) };
  return probe.result;
}
