import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../server.ts";
import type { FirebaseServices } from "../server/config.ts";
import { decodeCursor, encodeCursor, encodePartnerSong } from "../server/partner.ts";
import { signedAudio, storagePathFromUrl } from "../server/storage.ts";
import { hash } from "../server/limits.ts";

let running: Server | undefined;
afterEach(async () => {
  if (running) await new Promise<void>((resolve) => running?.close(() => resolve()));
  running = undefined;
});

function stubs() {
  const db = { doc: vi.fn(() => ({})), runTransaction: vi.fn((callback) => callback({
    get: async () => ({ get: () => undefined }), set: vi.fn(),
  })) };
  const token = (email: string, provider = "google.com", email_verified = true) =>
    ({ uid: "local-account", email, email_verified, firebase: { sign_in_provider: provider } });
  const auth = { verifyIdToken: vi.fn(async (value: string) => {
    if (value === "owner") return token("Owner@example.test");
    if (value === "unverified") return token("owner@example.test", "google.com", false);
    if (value === "password") return token("owner@example.test", "password");
    return token("outsider@example.test");
  }) };
  return { db, auth, bucket: { name: "test-studio.appspot.com", file: vi.fn() } };
}

async function launch(services: ReturnType<typeof stubs>) {
  const app = createApp(services as unknown as FirebaseServices, ["owner@example.test"]);
  const server = app.listen(0, "127.0.0.1");
  running = server;
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  return "http://127.0.0.1:" + address.port;
}

describe("local HTTP smoke", () => {
  it("requires owner auth and exact Google provider and rejects every foreign storage URL", async () => {
    const dependencies = stubs();
    const url = await launch(dependencies);
    expect((await fetch(url + "/api/session")).status).toBe(401);
    for (const token of ["outsider", "unverified", "password"]) {
      expect((await fetch(url + "/api/session", { headers: { Authorization: "Bearer " + token } })).status).toBe(403);
    }
    const headers = { Authorization: "Bearer owner" };
    expect((await fetch(url + "/api/session", { headers })).status).toBe(200);
    expect((await fetch(url + "/api/v1/songs")).status).toBe(401);
    expect((await fetch(url + "/api/storage-proxy?url=" + encodeURIComponent("https://example.test/songs/a.wav"), { headers })).status).toBe(400);
    expect((await fetch(url + "/api/storage-proxy", { method: "POST", headers })).status).toBe(405);
    expect((await fetch(url + "/api/storage-proxy", { method: "HEAD", headers })).status).toBe(405);
    expect(dependencies.bucket.file).not.toHaveBeenCalled();
  });
});
describe("partner API", () => {
  it("keeps the stable cursor tuple and rejects mismatched query filters", () => {
    const since = "2025-01-01T00:00:00.000Z";
    const cursor = encodeCursor("2025-01-02T00:00:00.000Z", "a", since);
    expect(decodeCursor(cursor, since)).toEqual({ t: "2025-01-02T00:00:00.000Z", id: "a", since });
    expect(() => decodeCursor(cursor, undefined)).toThrow(/cursor/);
    expect(() => decodeCursor("an-invalid-value")).toThrow(/cursor/);
    expect(encodePartnerSong("a", { voice_start_seconds: 0, private_field: "internal" })).toMatchObject({ id: "a", voice_start: 0 });
    expect(encodePartnerSong("a", { private_field: "internal" })).not.toHaveProperty("private_field");
  });
  it("checks bucket identity and studio path at every supported URL form", () => {
    const bucket = "studio.appspot.com";
    expect(storagePathFromUrl("https://firebasestorage.googleapis.com/v0/b/studio.appspot.com/o/songs%2Fa.wav?alt=media", bucket)).toBe("songs/a.wav");
    for (const value of [
      "https://storage.googleapis.com/studio.appspot.com.evil/songs/a.wav",
      "https://firebasestorage.googleapis.com/v0/b/studio.appspot.com/o/other%2Fa.wav",
      "https://storage.googleapis.com/studio.appspot.com/songs/%2e%2e/a.wav",
      "http://storage.googleapis.com/studio.appspot.com/songs/a.wav",
    ]) expect(() => storagePathFromUrl(value, bucket)).toThrow(/Invalid/);
  });
  it("signs the stored artifact for 15 minutes and hashes the actual bytes", async () => {
    const wav = Buffer.from("test-artifact");
    const signer = vi.fn().mockResolvedValue(["https://signed.example.test"]);
    const bucket = { file: vi.fn(() => ({
      getMetadata: async () => [{ size: String(wav.length), generation: "1" }],
      download: async () => [wav],
      getSignedUrl: signer,
    })) };
    const result = await signedAudio(bucket as unknown as FirebaseServices["bucket"], "songs/a.wav", "wav", 1_000);
    expect(signer).toHaveBeenCalledWith({ action: "read", version: "v4", expires: 901_000, responseType: "audio/wav" });
    expect(result).toEqual({ url: "https://signed.example.test", sha256: hash(wav), content_type: "audio/wav", bytes: wav.length });
  });
});
