import { constants } from "node:fs";
import { access, chmod, copyFile, mkdtemp, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { encodeMp3With, masterWavWith, testMastering } from "./audio.ts";
import { diagnosticMessage } from "./firebaseErrors.ts";
import { executeFfmpeg, FfmpegProcessError, type FfmpegCandidateName, type FfmpegFailure, type FfmpegRunner } from "./ffmpegProcess.ts";

const require = createRequire(import.meta.url);
const filename = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const coldMasterMs = 60_000;
const warmMasterMs = 25_000;

export interface FfmpegCandidate {
  name: FfmpegCandidateName;
  resolve: () => string | Promise<string>;
}

interface CandidateReport {
  candidate: FfmpegCandidateName;
  status: "selected" | "failed" | "not_tried";
  reason?: string;
  failures: FfmpegFailure[];
}

const copies = new Map<string, Promise<string>>();

export async function prepareFfmpegFile(path: string, tempRoot = tmpdir()) {
  const source = await realpath(path);
  const info = await stat(source);
  if (!info.isFile()) throw new Error("FFmpeg candidate is not a regular file.");
  if (process.platform === "win32") return source;
  if (info.mode & 0o111) {
    try { await access(source, constants.X_OK); return source; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    }
  }
  // Keep at most one executable copy per source for this process. An existing
  // job may still have another pass to run after the global probe is refreshed.
  const key = tempRoot + "\0" + source;
  let prepared = copies.get(key);
  if (!prepared) {
    prepared = (async () => {
      const dir = await mkdtemp(join(tempRoot, "darija-ffmpeg-"));
      const target = join(dir, filename);
      try {
        await copyFile(source, target);
        await chmod(target, 0o755);
        return target;
      } catch (error) {
        await unlink(target).catch(() => undefined);
        await rmdir(dir).catch(() => undefined);
        throw error;
      }
    })().catch((error) => {
      copies.delete(key);
      throw error;
    });
    copies.set(key, prepared);
  }
  return prepared;
}

function bundledPath() {
  const name = "@seydx/node-av-ffmpeg-lgpl-" + process.platform + "-" + process.arch;
  const cliRequire = createRequire(require.resolve("@seydx/node-av-ffmpeg-lgpl/package.json"));
  try { return cliRequire.resolve(name + "/" + filename); }
  catch {
    if (process.platform === "linux") {
      try { return cliRequire.resolve(name + "-musl/" + filename); }
      catch { /* No platform binary in the installed dependencies. */ }
    }
  }
  throw new Error("Bundled FFmpeg is missing for " + process.platform + "/" + process.arch + ".");
}

function staticPath() {
  const path: unknown = require("ffmpeg-static");
  if (typeof path !== "string") throw new Error("ffmpeg-static has no binary for this platform.");
  return path;
}

async function systemPath(pathEnv: string) {
  for (const part of pathEnv.split(delimiter)) {
    const directory = part.trim().replace(/^"|"$/g, "");
    if (!isAbsolute(directory)) continue;
    const path = join(directory, filename);
    if (await stat(path).then((entry) => entry.isFile(), () => false)) return path;
  }
  throw new Error("No regular FFmpeg file was found on PATH.");
}

export function ffmpegCandidates(override?: string, pathEnv = process.env.PATH ?? ""): FfmpegCandidate[] {
  const choices: FfmpegCandidate[] = [];
  if (override?.trim()) choices.push({ name: "FFMPEG_PATH", resolve: () => {
    const path = override.trim();
    if (!isAbsolute(path)) throw new Error("FFMPEG_PATH must be an absolute executable path.");
    return path;
  } });
  return [...choices, { name: "bundled", resolve: bundledPath }, { name: "ffmpeg-static", resolve: staticPath },
    { name: "PATH", resolve: () => systemPath(pathEnv) }];
}

function audioArgs(args: string[]) {
  return ["-nostdin", "-hide_banner", "-nostats", "-y", ...args];
}

async function probe(path: string, candidate: FfmpegCandidateName, command: typeof executeFfmpeg) {
  const { stdout } = await command(path, ["-version"], { candidate, phase: "version", timeoutMs: 30_000, synthetic: true });
  const version = /^ffmpeg version ([\w.+-]{1,100})(?:\s|$)/im.exec(stdout)?.[1];
  if (!version) throw new Error("The executable did not report an FFmpeg version.");

  // Probe sequentially so a failed command finishes before the same candidate is retried.
  const filters = await command(path, ["-hide_banner", "-filters"],
    { candidate, phase: "filters", timeoutMs: 10_000, synthetic: true });
  const encoders = await command(path, ["-hide_banner", "-encoders"],
    { candidate, phase: "encoders", timeoutMs: 10_000, synthetic: true });
  if (!/^\s*[A-Z.]+\s+loudnorm\s/m.test(filters.stdout)) throw new Error("FFmpeg is missing the loudnorm filter.");
  if (!/^\s*A[A-Z.]+\s+libmp3lame\s/m.test(encoders.stdout)) throw new Error("FFmpeg is missing the libmp3lame encoder.");

  await testMastering((phase, args) => command(path, audioArgs(args),
    { candidate, phase, timeoutMs: coldMasterMs, synthetic: true }));
  return version;
}

function processFailure(error: unknown) {
  for (let depth = 0; depth < 3 && error instanceof Error; depth++) {
    if (error instanceof FfmpegProcessError) return error;
    error = error.cause;
  }
  return null;
}

function failureReason(error: unknown) {
  const failure = processFailure(error);
  if (failure) return failure.message;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "No executable file was found for this candidate.";
  if (code === "EACCES" || code === "EPERM") return "Access to the FFmpeg candidate or temporary directory was denied.";
  return diagnosticMessage(error instanceof Error ? error.message : "FFmpeg probe failed.");
}

export async function selectFfmpeg(choices: FfmpegCandidate[], command = executeFfmpeg) {
  const reports: CandidateReport[] = choices.map(({ name }) => ({ candidate: name, status: "not_tried", failures: [] }));
  for (const [index, choice] of choices.entries()) {
    const report = reports[index];
    try {
      const path = await prepareFfmpegFile(await choice.resolve());
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const version = await probe(path, choice.name, command);
          report.status = "selected";
          return { winner: { candidate: choice.name, path, version }, reports };
        } catch (error) {
          const failure = processFailure(error);
          if (failure) report.failures.push(failure.diagnostic);
          if (attempt === 2 || !failure) throw error;
        }
      }
    } catch (error) {
      report.status = "failed";
      report.reason = failureReason(error);
    }
  }
  return { winner: null, reports };
}

type Selection = ReturnType<typeof selectFfmpeg>;
let cached: { override?: string; pathEnv: string; selection: Selection; coldMaster: boolean } | undefined;
let lastFailure: FfmpegFailure | null = null;

function state() {
  const override = process.env.FFMPEG_PATH;
  const pathEnv = process.env.PATH ?? "";
  if (!cached || cached.override !== override || cached.pathEnv !== pathEnv) {
    cached = { override, pathEnv, selection: selectFfmpeg(ffmpegCandidates(override, pathEnv)), coldMaster: true };
  }
  return cached;
}

export async function ffmpegHealth() {
  const { winner, reports } = await state().selection;
  return {
    ffmpeg_path: winner?.path ?? null,
    ffmpeg_candidate: winner?.candidate ?? null,
    ffmpeg_version: winner?.version ?? null,
    ffmpeg_present: Boolean(winner),
    loudnorm: Boolean(winner),
    libmp3lame: Boolean(winner),
    ffmpeg_master_test: Boolean(winner),
    ffmpeg_candidates: reports,
    ffmpeg_last_failure: lastFailure,
  };
}

async function withFfmpeg<T>(mastering: boolean, action: (run: FfmpegRunner) => Promise<T>) {
  const entry = state();
  const { winner } = await entry.selection;
  if (!winner) throw new Error("No FFmpeg candidate passed the mastering test.");
  const timeoutMs = mastering && entry.coldMaster ? coldMasterMs : warmMasterMs;
  if (mastering) entry.coldMaster = false;
  try {
    return await action((phase, args) => executeFfmpeg(winner.path, audioArgs(args),
      { candidate: winner.candidate, phase, timeoutMs, synthetic: false }));
  } catch (error) {
    const failure = processFailure(error);
    if (failure) {
      lastFailure = failure.diagnostic;
      if (failure.shouldReprobe && cached === entry) {
        cached = undefined;
        void state().selection;
      }
    }
    throw error;
  }
}

export function masterWav(input: Buffer, targetLength: number, repair = false) {
  return withFfmpeg(true, (run) => masterWavWith(run, input, targetLength, repair));
}

export function encodeMp3(wav: Buffer) {
  return withFfmpeg(false, (run) => encodeMp3With(run, wav));
}
