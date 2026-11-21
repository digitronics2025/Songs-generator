import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { diagnosticMessage } from "./firebaseErrors.ts";

export type FfmpegCandidateName = "FFMPEG_PATH" | "bundled" | "ffmpeg-static" | "PATH";
export type FfmpegPhase = "version" | "filters" | "encoders" | "encode_mp3" | "master_pass1" | "master_pass2" | "master_measure";
export type FfmpegRunner = (phase: FfmpegPhase, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface FfmpegFailure {
  candidate: FfmpegCandidateName;
  phase: FfmpegPhase;
  exit_code: number | null;
  error_code: string | null;
  signal: string | null;
  killed: boolean;
  timed_out: boolean;
  elapsed_ms: number;
  stderr: string;
}

export class FfmpegProcessError extends Error {
  constructor(readonly diagnostic: FfmpegFailure) {
    const { candidate, phase, timed_out, exit_code, signal, error_code, stderr } = diagnostic;
    const reason = timed_out ? "timed out" : signal ? "terminated with " + signal :
      exit_code !== null ? "exited with code " + exit_code : error_code ?? "could not start";
    super("FFmpeg (" + candidate + ") " + reason + " during " + phase + (stderr ? ". " + stderr : "."));
    this.name = "FfmpegProcessError";
  }

  get code() {
    return this.diagnostic.error_code ?? this.diagnostic.exit_code ?? undefined;
  }

  get shouldReprobe() {
    return Boolean(this.diagnostic.signal ||
      (this.diagnostic.exit_code === null && this.diagnostic.error_code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"));
  }
}

// Media stderr can contain arbitrary embedded artwork, tags, or file metadata.
// Keep recognized decoder/OS diagnostics, without emitting dynamic media text.
const mediaDiagnostics = [
  "Invalid data found when processing input", "Error opening input", "Failed to read frame size",
  "Header missing", "Could not find codec parameters", "Error while decoding stream",
  "No such file or directory", "Permission denied", "No space left on device", "Cannot allocate memory",
  "error while loading shared libraries", "Unknown encoder", "No such filter",
  "Error initializing filter", "Conversion failed", "Broken pipe",
];

function stderrPreview(stderr: string, synthetic: boolean) {
  if (synthetic) return diagnosticMessage(stderr).slice(0, 300);
  if (!stderr.trim()) return "";
  const known = mediaDiagnostics.filter((message) => stderr.includes(message));
  return (known.length ? known.join(". ") : "[media stderr redacted]").slice(0, 300);
}

export function executeFfmpeg(path: string, args: string[], options: {
  candidate: FfmpegCandidateName;
  phase: FfmpegPhase;
  timeoutMs: number;
  synthetic: boolean;
}) {
  const start = performance.now();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let timedOut = false;
    const child = execFile(path, args, { maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (!error) return resolve({ stdout, stderr });
      const exitCode = typeof error.code === "number" ? error.code : child.exitCode;
      const diagnostic: FfmpegFailure = {
        candidate: options.candidate,
        phase: options.phase,
        exit_code: exitCode !== null && exitCode >= 0 ? exitCode : null,
        error_code: typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null,
        signal: error.signal ?? child.signalCode,
        killed: Boolean(error.killed || child.killed),
        timed_out: timedOut,
        elapsed_ms: Math.round(performance.now() - start),
        stderr: stderrPreview(stderr, options.synthetic),
      };
      console.warn(JSON.stringify({ event: "ffmpeg_call_failed", ...diagnostic }));
      reject(new FfmpegProcessError(diagnostic));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs).unref();
  });
}
