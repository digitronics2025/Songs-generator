import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server.ts";
import type { FirebaseServices } from "../server/config.ts";
import { authFailure, DATA_CONFIGURATION, SIGN_IN_CONFIGURATION } from "../server/firebaseErrors.ts";
import * as ffmpegProcess from "../server/ffmpegProcess.ts";

const owner = "owner@example.test";
const header = { Authorization: "Bearer local-test-owner-token" };
const signedFixture = "https://example.test/private?X-Goog-Signature=fixture";
let server: Server | undefined;
const bundledHealth = {
  ffmpeg_candidate: "bundled", ffmpeg_present: true, ffmpeg_version: expect.any(String),
  loudnorm: true, libmp3lame: true, ffmpeg_master_test: true, ffmpeg_last_failure: null,
  ffmpeg_candidates: [
    { candidate: "bundled", status: "selected", failures: [] },
    { candidate: "ffmpeg-static", status: "not_tried", failures: [] },
    { candidate: "PATH", status: "not_tried", failures: [] },
  ],
};

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const denied = (code: string | number) => Object.assign(new Error("Permission denied"), { code });

function dependencies() {
  const verifyIdToken = vi.fn(async (token: string) => {
    if (token === "invalid-token") throw Object.assign(new Error("Invalid token"), { code: "auth/argument-error" });
    return { uid: "private-user-id", email: token === "outsider" ? "visitor@example.test" : owner,
      email_verified: true, firebase: { sign_in_provider: "google.com" } };
  });
  const docGet = vi.fn().mockResolvedValue({ data: () => ({ internal: "do-not-return" }) });
  const getMetadata = vi.fn().mockResolvedValue([{ name: "songs/private.wav" }]);
  const getSignedUrl = vi.fn().mockResolvedValue([signedFixture]);
  const getFiles = vi.fn().mockResolvedValue([[{ name: "songs/another-private.wav" }]]);
  return {
    db: {
      doc: vi.fn(() => ({ get: docGet })),
      runTransaction: vi.fn(async (fn) => fn({ get: async () => ({ get: () => undefined }), set: vi.fn() })),
      docGet,
    },
    auth: { verifyIdToken },
    bucket: { name: "private-bucket", file: vi.fn(() => ({ getMetadata, getSignedUrl })), getMetadata, getSignedUrl, getFiles },
  };
}

async function launch(services: ReturnType<typeof dependencies>, checkModel = vi.fn(async (model: string | null) => Boolean(model))) {
  server = createApp(services as unknown as FirebaseServices, [owner], checkModel).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local studio test server unavailable.");
  return "http://127.0.0.1:" + address.port;
}

describe("Firebase error mapping", () => {
  it.each([
    ["auth/id-token-expired", /expired/],
    ["auth/argument-error", /invalid sign-in token/i],
    ["auth/invalid-id-token", /invalid sign-in token/i],
    ["auth/id-token-revoked", /no longer active/],
    ["auth/user-disabled", /no longer active/],
  ])("maps %s to a clear 401", (code, message) => {
    expect(authFailure(denied(code))).toMatchObject({ status: 401, message: expect.stringMatching(message) });
  });

  it.each(["auth/invalid-credential", "auth/insufficient-permission", "auth/internal-error", "ECONNRESET", "app/invalid-credential"])(
    "maps %s to 503", (code) => {
      expect(authFailure(denied(code))).toMatchObject({ status: 503, message: SIGN_IN_CONFIGURATION });
    },
  );

  it("logs configuration failures with the code and message while redacting the submitted token and configured API key", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = dependencies();
    const configuredKey = "local-test-configured-value";
    vi.stubEnv("GEMINI_API_KEY", configuredKey);
    app.auth.verifyIdToken.mockRejectedValueOnce(Object.assign(
      new Error("Permission denied for " + header.Authorization + " " + owner + " API key=" + configuredKey),
      { code: "auth/insufficient-permission" },
    ));
    const url = await launch(app);
    const response = await fetch(url + "/api/session", { headers: header });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: SIGN_IN_CONFIGURATION });
    const entry = JSON.parse(String(log.mock.calls[0][0]));
    expect(entry).toMatchObject({ operation: "verify_sign_in", code: "auth/insufficient-permission",
      message: expect.stringContaining("Permission denied") });
    expect(entry.message).not.toContain("local-test-owner-token");
    expect(entry.message).not.toContain(configuredKey);
    expect(entry.message).not.toContain(owner);
  });

  it("maps Firestore gRPC and Cloud Storage HTTP permission failures to 503", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = dependencies();
    const url = await launch(app);
    app.db.runTransaction.mockRejectedValueOnce(denied(7));
    const firestore = await fetch(url + "/api/library", { headers: header });
    expect(firestore.status).toBe(503);
    expect(await firestore.json()).toEqual({ error: DATA_CONFIGURATION });
    app.bucket.getMetadata.mockRejectedValueOnce(denied(403));
    const storage = await fetch(url + "/api/storage-proxy?path=songs%2Ftest.wav", { headers: header });
    expect(storage.status).toBe(503);
    expect(await storage.json()).toEqual({ error: DATA_CONFIGURATION });
    expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)).code)).toEqual(["7", "403"]);
  });
});

describe("owner verification and setup health", () => {
  it.each([[undefined, false], ["0", false], ["true", false], ["1", true]] as const)(
    "uses revocation mode %s", async (value, expected) => {
      vi.stubEnv("AUTH_CHECK_REVOKED", value);
      const app = dependencies();
      const url = await launch(app);
      expect((await fetch(url + "/api/session", { headers: header })).status).toBe(200);
      expect(app.auth.verifyIdToken).toHaveBeenCalledWith("local-test-owner-token", expected);
    },
  );

  it("offers only a liveness boolean to anonymous callers and no capabilities to rejected callers", async () => {
    const app = dependencies();
    const url = await launch(app);
    const path = url + "/api/health/setup";
    const publicResponse = await fetch(path);
    expect(publicResponse.headers.get("cache-control")).toBe("no-store");
    expect(await publicResponse.json()).toEqual({ ok: true });
    expect(app.auth.verifyIdToken).not.toHaveBeenCalled();
    for (const [token, status] of [["outsider", 403], ["invalid-token", 401]] as const) {
      const response = await fetch(path, { headers: { Authorization: "Bearer " + token } });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false });
    }
    expect(app.db.doc).not.toHaveBeenCalled();
    expect(app.bucket.file).not.toHaveBeenCalled();
    expect(app.bucket.getFiles).not.toHaveBeenCalled();
  });

  it("probes only the Studio path and returns booleans and the owner count", async () => {
    vi.stubEnv("GEMINI_API_KEY", "local-test-configured-value");
    const app = dependencies();
    const url = await launch(app);
    const response = await fetch(url + "/api/health/setup", { headers: header });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, token_verified: true, firestore: true, storage_read: true,
      storage_list: true, signed_url: true, owner_count: 1, gemini_key_present: true,
      gemini_text_model: "gemini-4-hydrogen", gemini_text_model_available: true,
      ...bundledHealth,
    });
    expect(app.db.doc).toHaveBeenCalledWith("settings/app_settings");
    expect(app.db.runTransaction).not.toHaveBeenCalled();
    expect(app.bucket.file.mock.calls).toEqual([["songs/_studio_setup_probe.wav"], ["songs/_studio_setup_probe.wav"]]);
    expect(app.bucket.getFiles).toHaveBeenCalledWith({ prefix: "songs/", maxResults: 1, autoPaginate: false });
    expect(app.bucket.getSignedUrl).toHaveBeenCalledWith({ version: "v4", action: "read", expires: expect.any(Number) });
  });

  it("reports why the override failed and the selected fallback only to the owner", async () => {
    vi.stubEnv("GEMINI_API_KEY", "local-test-configured-value");
    const override = join(tmpdir(), "studio-missing-ffmpeg-test", "ffmpeg");
    vi.stubEnv("FFMPEG_PATH", override);
    const url = await launch(dependencies());
    const response = await fetch(url + "/api/health/setup", { headers: header });
    expect(response.status).toBe(200);
    const health = await response.json();
    expect(health).toMatchObject({
      ok: true, ffmpeg_candidate: "bundled", ffmpeg_master_test: true,
      ffmpeg_candidates: [
        { candidate: "FFMPEG_PATH", status: "failed", reason: "No executable file was found for this candidate." },
        ...bundledHealth.ffmpeg_candidates,
      ],
    });
    expect(health).not.toHaveProperty("ffmpeg_path");
    expect(JSON.stringify(health)).not.toContain(override);
  });

  it("returns subprocess diagnostics after attempts fail without exposing a configured secret", async () => {
    const key = "local-test-configured-value";
    vi.stubEnv("GEMINI_API_KEY", key);
    vi.stubEnv("FFMPEG_PATH", process.execPath);
    const run = ffmpegProcess.executeFfmpeg;
    const logs = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const command = vi.spyOn(ffmpegProcess, "executeFfmpeg").mockImplementation((file, args, options) =>
      options.candidate === "FFMPEG_PATH" ? run(process.execPath, ["-e",
        "process.stderr.write(" + JSON.stringify("Loader error " + key) + "); process.exitCode = 23"], options) : run(file, args, options));
    const url = await launch(dependencies());
    const response = await fetch(url + "/api/health/setup", { headers: header });
    expect(response.status).toBe(200);
    const health = await response.json();
    const { candidate, status, failures } = health.ffmpeg_candidates[0];
    expect({ candidate, status }).toEqual({ candidate: "FFMPEG_PATH", status: "failed" });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      exit_code: 23, signal: null, killed: false, timed_out: false, elapsed_ms: expect.any(Number),
      phase: "version", stderr: "Loader error [redacted]",
    });
    expect(JSON.stringify(health)).not.toContain(key);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(key);
    expect(command).toHaveBeenCalledWith(process.execPath, ["-version"], expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("reports the configured Gemini model when metadata verification fails", async () => {
    vi.stubEnv("GEMINI_API_KEY", "local-test-configured-value");
    const app = dependencies();
    app.db.docGet.mockResolvedValue({ data: () => ({ text_model: "gemini-unavailable" }) });
    const checkModel = vi.fn(async (_model: string | null) => false);
    const url = await launch(app, checkModel);
    const response = await fetch(url + "/api/health/setup", { headers: header });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false, gemini_text_model: "gemini-unavailable", gemini_text_model_available: false,
    });
    expect(checkModel).toHaveBeenCalledWith("gemini-unavailable");
  });

  it("reports IAM failures independently and keeps the owner diagnostics available when Firestore fails", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = dependencies();
    app.db.docGet.mockRejectedValueOnce(denied(7));
    app.bucket.getMetadata.mockRejectedValueOnce(Object.assign(new Error("No such object"), { code: 404 }));
    app.bucket.getFiles.mockRejectedValueOnce(denied(403));
    app.bucket.getSignedUrl.mockRejectedValueOnce(Object.assign(
      new Error("signBlob permission denied at " + signedFixture), { name: "SigningError" },
    ));
    const url = await launch(app);
    const response = await fetch(url + "/api/health/setup", { headers: header });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false, token_verified: true, firestore: false, storage_read: true,
      storage_list: false, signed_url: false, owner_count: 1, gemini_key_present: false,
      gemini_text_model: null, gemini_text_model_available: false,
      ...bundledHealth,
    });
    expect(log.mock.calls).toHaveLength(3);
    expect(JSON.stringify(log.mock.calls)).not.toContain(signedFixture);
  });
});
