import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ffmpegCandidates, ffmpegHealth, masterWav, prepareFfmpegFile, selectFfmpeg } from "../server/ffmpeg.ts";
import * as subprocess from "../server/ffmpegProcess.ts";
import { tone } from "./audioFixture.ts";

const { executeFfmpeg, FfmpegProcessError } = subprocess;
const options = { candidate: "bundled", phase: "version", timeoutMs: 5_000, synthetic: true } as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function failedCommand(details: Partial<subprocess.FfmpegFailure> = {}) {
  return new FfmpegProcessError({
    candidate: "bundled", phase: "version", exit_code: 1, error_code: null,
    signal: null, killed: false, timed_out: false, elapsed_ms: 20, stderr: "", ...details,
  });
}

describe("FFmpeg selection", () => {
  it("uses the requested order and omits an unset override", () => {
    expect(ffmpegCandidates(process.execPath).map(({ name }) => name))
      .toEqual(["FFMPEG_PATH", "bundled", "ffmpeg-static", "PATH"]);
    expect(ffmpegCandidates().map(({ name }) => name)).toEqual(["bundled", "ffmpeg-static", "PATH"]);
  });

  it("retries a broken version probe, rejects a failed master and selects the installed static fallback", async () => {
    const choices = ffmpegCandidates(process.execPath);
    choices[1].resolve = () => process.execPath;
    const staticPath = await choices[2].resolve();
    const command = vi.fn<typeof executeFfmpeg>(async (path, args, config) => {
      const { candidate, phase } = config;
      if (candidate === "FFMPEG_PATH" || (candidate === "bundled" && phase === "master_pass2")) {
        throw failedCommand({ candidate, phase });
      }
      // Exercise the installed fallback binary, including the real synthetic master.
      return executeFfmpeg(candidate === "bundled" ? staticPath : path, args, config);
    });
    const { winner, reports } = await selectFfmpeg(choices, command);
    expect(winner).toMatchObject({ candidate: "ffmpeg-static" });
    expect(reports.map(({ candidate, status }) => [candidate, status])).toEqual([
      ["FFMPEG_PATH", "failed"], ["bundled", "failed"], ["ffmpeg-static", "selected"], ["PATH", "not_tried"],
    ]);
    expect(reports[0].failures).toHaveLength(2);
    expect(reports[1].failures.map(({ phase }) => phase)).toEqual(["master_pass2", "master_pass2"]);
    expect(command.mock.calls.filter(([, , config]) => config.phase === "version")
      .map(([, , config]) => [config.candidate, config.timeoutMs])).toEqual([
      ["FFMPEG_PATH", 30_000], ["FFMPEG_PATH", 30_000], ["bundled", 30_000], ["bundled", 30_000], ["ffmpeg-static", 30_000],
    ]);
  }, 20_000);

  it("reaches PATH when no package works and explains every rejection if PATH fails too", async () => {
    const choices = ffmpegCandidates(process.execPath).map((choice) => ({ ...choice, resolve: () => process.execPath }));
    const command = vi.fn<typeof executeFfmpeg>(async (_path, _args, { candidate, phase }) => {
      throw failedCommand({ candidate, phase, error_code: "ENOEXEC", exit_code: null });
    });
    const { winner, reports } = await selectFfmpeg(choices, command);
    expect(winner).toBeNull();
    expect(reports.every(({ status, reason, failures }) =>
      status === "failed" && reason?.includes("ENOEXEC") && failures.length === 2)).toBe(true);
    expect(command.mock.calls.map(([, , { candidate }]) => candidate)).toEqual([
      "FFMPEG_PATH", "FFMPEG_PATH", "bundled", "bundled", "ffmpeg-static", "ffmpeg-static", "PATH", "PATH",
    ]);
  });

  it.skipIf(process.platform === "win32")("copies a non-executable regular file and makes only the copy executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-test-ffmpeg-"));
    try {
      const source = join(root, "no-execute");
      const executable = "#!/bin/sh\nprintf 'copy executed'\n";
      await writeFile(source, executable);
      await chmod(source, 0o644);
      const copy = await prepareFfmpegFile(source, root);

      expect(copy.startsWith(join(root, "darija-ffmpeg-"))).toBe(true);
      expect(await readFile(copy, "utf8")).toBe(executable);
      expect((await executeFfmpeg(copy, [], options)).stdout).toBe("copy executed");
      expect((await stat(copy)).mode & 0o777).toBe(0o755);
      expect((await stat(source)).mode & 0o777).toBe(0o644);
      expect(await prepareFfmpegFile(source, root)).toBe(copy);
      await expect(prepareFfmpegFile(root, root)).rejects.toThrow("not a regular file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows longer cold passes, re-probes after a runtime signal, and retains the diagnostic for health", async () => {
    vi.stubEnv("FFMPEG_PATH", process.execPath);
    const bundledPath = await ffmpegCandidates()[0].resolve();
    const signal = failedCommand({ candidate: "FFMPEG_PATH", phase: "master_pass1", exit_code: null,
      signal: "SIGTERM", elapsed_ms: 3, stderr: "Conversion failed" });
    let realMasters = 0;
    let overrideFailed = false;
    const command = vi.spyOn(subprocess, "executeFfmpeg").mockImplementation(async (_path, args, config) => {
      if (!config.synthetic && config.phase === "master_pass1" && ++realMasters === 2) {
        overrideFailed = true;
        throw signal;
      }
      if (overrideFailed && config.candidate === "FFMPEG_PATH" && config.phase === "version") {
        throw failedCommand({ candidate: "FFMPEG_PATH", exit_code: null, error_code: "ENOENT" });
      }
      return executeFfmpeg(bundledPath, args, config);
    });

    const startup = await Promise.all([ffmpegHealth(), ffmpegHealth()]);
    expect(startup.map(({ ffmpeg_candidate }) => ffmpeg_candidate)).toEqual(["FFMPEG_PATH", "FFMPEG_PATH"]);
    await masterWav(tone(), 1);
    await expect(masterWav(tone(), 1)).rejects.toMatchObject({ cause: signal });
    const after = await ffmpegHealth();

    expect(after).toMatchObject({ ffmpeg_candidate: "bundled", ffmpeg_master_test: true, ffmpeg_last_failure: signal.diagnostic });
    const configs = command.mock.calls.map(([, , config]) => config);
    expect(configs.filter(({ phase }) => phase === "version").map(({ candidate }) => candidate))
      .toEqual(["FFMPEG_PATH", "FFMPEG_PATH", "FFMPEG_PATH", "bundled"]);
    expect(configs.filter(({ synthetic }) => !synthetic).map(({ timeoutMs }) => timeoutMs))
      .toEqual([60_000, 60_000, 60_000, 25_000]);
  }, 20_000);
});

describe("FFmpeg process diagnostics", () => {
  it("reports a bounded, redacted stderr preview and real exit code for a synthetic probe", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const signedUrl = "https://example.test/songs/private?X-Goog-Signature=test-fixture";
    const command = "process.stderr.write(" + JSON.stringify("Startup error " + signedUrl + " " + "x".repeat(400)) + "); process.exitCode = 7";
    const error = await executeFfmpeg(process.execPath, ["-e", command], options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FfmpegProcessError);
    const { diagnostic } = error as subprocess.FfmpegProcessError;
    expect(diagnostic).toMatchObject({
      exit_code: 7, error_code: null, signal: null, killed: false, timed_out: false,
      elapsed_ms: expect.any(Number), stderr: expect.stringMatching(/^Startup error \[url\]/),
    });
    expect(diagnostic.stderr).toHaveLength(300);
    expect(logs).toHaveBeenCalledWith(JSON.stringify({ event: "ffmpeg_call_failed", ...diagnostic }));
    expect(JSON.stringify(logs.mock.calls)).not.toContain(signedUrl);
  });

  it("flags timeouts and preserves the signal and elapsed time", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timeoutMs = 750;
    await expect(executeFfmpeg(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...options, timeoutMs }))
      .rejects.toMatchObject({ diagnostic: { timed_out: true, killed: true, signal: "SIGKILL" } });
    const call = JSON.parse(String(logs.mock.calls[0][0]));
    expect(call.elapsed_ms).toBeGreaterThanOrEqual(timeoutMs - 10);
  });

  it.skipIf(process.platform === "win32")("distinguishes an unsolicited signal from a local timeout", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(executeFfmpeg(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], options))
      .rejects.toMatchObject({ shouldReprobe: true, diagnostic: {
        exit_code: null, signal: "SIGTERM", killed: false, timed_out: false,
      } });
  });

  it("treats an executable that disappears as a spawn failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(executeFfmpeg(join(tmpdir(), "darija-missing-executable", "not-found"), [], options))
      .rejects.toMatchObject({ shouldReprobe: true, diagnostic: {
        exit_code: null, error_code: "ENOENT", killed: false, timed_out: false,
      } });
  });

  it("keeps arbitrary media metadata out of logs and health diagnostics", async () => {
    const logs = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mediaTag = "private fixture metadata";
    const command = "process.stderr.write(" + JSON.stringify("comment: " + mediaTag + "\nConversion failed") + "); process.exitCode = 1";
    await expect(executeFfmpeg(process.execPath, ["-e", command], { ...options, phase: "master_pass1", synthetic: false }))
      .rejects.toMatchObject({ diagnostic: { stderr: "Conversion failed" } });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(mediaTag);
  });
});
