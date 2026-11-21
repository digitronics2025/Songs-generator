import { readFile } from "node:fs/promises";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";
import { createApp } from "../server.ts";
import { firebaseServices, type FirebaseServices } from "../server/config.ts";
import { reserveBudget, hash } from "../server/limits.ts";
import { migrateCatalog } from "../server/migration.ts";
import { renderRules } from "../scripts/render-rules.ts";
import { INITIAL_SONGS } from "../src/data/songs.ts";

const projectId = "demo-darija-studio";
const ownerEmail = "owner@example.test";
const settings = { daily_budget_usd: 0.10 };
let env: RulesTestEnvironment;
let services: FirebaseServices;
let server: Server;
let origin: string;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
      !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Firebase tests require local emulators.");
  process.env.STUDIO_EMULATOR = "1";
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: renderRules(await readFile("firestore.rules", "utf8"), [ownerEmail]) },
    storage: { rules: renderRules(await readFile("storage.rules", "utf8"), [ownerEmail]) },
  });
  services = firebaseServices();
  server = createApp(services, [ownerEmail]).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No emulator test server.");
  origin = "http://127.0.0.1:" + address.port;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await env?.cleanup();
});

function context(email: string, provider: "google.com" | "password" = "google.com", verified = true) {
  return env.authenticatedContext(email, {
    email, email_verified: verified,
    firebase: { sign_in_provider: provider, identities: {} },
  });
}

async function googleToken(email: string) {
  const body = new URLSearchParams({ providerId: "google.com", id_token: JSON.stringify({ sub: email, email, email_verified: true }) });
  const response = await fetch("http://" + process.env.FIREBASE_AUTH_EMULATOR_HOST +
    "/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestUri: "http://localhost", postBody: body.toString(), returnSecureToken: true }),
    });
  if (!response.ok) throw new Error("Auth emulator login failed with HTTP " + response.status);
  return (await response.json() as { idToken: string }).idToken;
}

describe("Firebase rules", () => {
  it("limits reads to verified allow-listed Google accounts and denies direct writes and internal reads", async () => {
    const { db } = services;
    await db.doc("songs/rules-fixture").set({ number: 123, title: "بيتنا" });
    const owner = context("OWNER@example.test").firestore();
    await assertSucceeds(getDoc(doc(owner, "songs/rules-fixture")));
    await assertSucceeds(getDocs(collection(owner, "songs")));
    await assertFails(setDoc(doc(owner, "songs/rules-fixture"), { status: "approved" }, { merge: true }));
    await assertFails(getDoc(doc(owner, "api_clients/example")));
    const outsider = context("visitor@example.test");
    for (const requester of [outsider, context(ownerEmail, "password"), context(ownerEmail, "google.com", false), env.unauthenticatedContext()]) {
      await assertFails(getDoc(doc(requester.firestore(), "songs/rules-fixture")));
    }
  });
  it("permits only owner reads and denies direct object mutation", async () => {
    const audioPath = "songs/rules-fixture.wav";
    await services.bucket.file(audioPath).save(Buffer.from("fixture"), { resumable: false, contentType: "audio/wav" });
    const owner = context(ownerEmail).storage("gs://" + services.bucket.name);
    await assertSucceeds(getBytes(ref(owner, audioPath)));
    await assertFails(uploadBytes(ref(owner, audioPath), new Uint8Array([1])));
    await assertFails(uploadBytes(ref(owner, "songs/new.wav"), new Uint8Array([1])));
    for (const requester of [context("visitor@example.test"), context(ownerEmail, "password"), env.unauthenticatedContext()]) {
      await assertFails(getBytes(ref(requester.storage("gs://" + services.bucket.name), audioPath)));
    }
  });
});

describe("real local Express, Auth and Firestore", () => {
  it("returns the production smoke status codes using local ID tokens", async () => {
    const [owner, outsider] = await Promise.all([googleToken(ownerEmail), googleToken("visitor@example.test")]);
    const headers = (token: string) => ({ Authorization: "Bearer " + token });
    expect((await fetch(origin + "/api/session")).status).toBe(401);
    expect((await fetch(origin + "/api/session", { headers: headers(outsider) })).status).toBe(403);
    expect((await fetch(origin + "/api/session", { headers: headers(owner) })).status).toBe(200);
    expect((await fetch(origin + "/api/v1/songs")).status).toBe(401);
    expect((await fetch(origin + "/api/storage-proxy?url=https%3A%2F%2Fexample.test%2Fsongs%2Fa.wav",
      { headers: headers(owner) })).status).toBe(400);
  });

  it("runs the migration twice, seeds defaults, and retains previous lyrics/audio and unknown fields", async () => {
    const db = services.db;
    const ref = db.doc("songs/1");
    const initial = {
      ...INITIAL_SONGS[0], status: "pending", title: "قديم", lines: ["دار قديمة"],
      admin_feeling: "family_evening", ownerId: "legacy", file_name: "01-original.wav",
      storage_path: "songs/01-original.wav", extra_legacy: { keep: true },
    };
    await ref.set(initial);
    const check = await migrateCatalog(db, "fake-owner", true);
    expect(check.seeded).toBe(INITIAL_SONGS.length - 1);
    expect((await ref.get()).data()).toEqual(initial);
    const firstPass = await migrateCatalog(db, "fake-owner", false);
    const after = (await ref.get()).data();
    const history = await db.collection("song_history").get();
    const takes = await ref.collection("takes").get();
    expect(firstPass.migrated).toBeGreaterThanOrEqual(INITIAL_SONGS.length);
    expect(after).toMatchObject({ title: INITIAL_SONGS[0].title, lines: INITIAL_SONGS[0].lines, status: "draft",
      storage_path: initial.storage_path, file_name: initial.file_name, extra_legacy: initial.extra_legacy,
      admin_feeling: "mothers_care", ownerId: "legacy" });
    expect(takes.size).toBe(1);
    expect(takes.docs[0].get("storage_path")).toBe(initial.storage_path);
    expect(history.docs.find((entry) => entry.get("title") === initial.title)?.get("lines")).toEqual(initial.lines);
    expect((await migrateCatalog(db, "fake-owner", false)).migrated).toBe(0);
    expect((await ref.get()).data()).toEqual(after);
    expect((await ref.collection("takes").get()).size).toBe(1);
    expect((await db.collection("song_history").get()).size).toBe(history.size);
  });

  it("reserves the daily budget atomically across competing callers", async () => {
    await services.db.doc("settings/app_settings").set(settings);
    const attempts = await Promise.allSettled([reserveBudget(services.db, 60_000), reserveBudget(services.db, 60_000)]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  });

  it("uses the saved ID beyond the seed catalog, blocks an active lease and never dispatches paid emulator calls", async () => {
    const db = services.db;
    const songId = "after-seed";
    const number = INITIAL_SONGS.length + 42;
    const original = { ...INITIAL_SONGS[0], id: songId, number, ownerId: "fixture", status: "lyric_approved" };
    const ref = db.doc("songs/" + songId);
    const lock = db.doc("studio_locks/" + songId);
    await ref.set(original);
    await lock.set({ token: "active", expires_at: Date.now() + 100_000 });
    const token = await googleToken(ownerEmail);
    const headers = { Authorization: "Bearer " + token };
    const generate = () => fetch(origin + "/api/songs/" + songId + "/generate", { method: "POST", headers });
    expect((await generate()).status).toBe(409);
    await lock.update({ expires_at: 0 });
    expect((await generate()).status).toBe(503);
    expect((await ref.get()).data()).toEqual(original);
    expect((await ref.collection("takes").get()).empty).toBe(true);
  });

  it("imports history idempotently and writes an audit trail for edits and archive", async () => {
    const db = services.db;
    const token = await googleToken(ownerEmail);
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const importBody = [{ source: "external", id: "one", feeling: "new_home", title: "دارنا", lines: ["دارنا الزوينة"] }];
    const request = (endpoint: string, method: string, body: unknown) => fetch(origin + "/api" + endpoint,
      { method, headers, body: JSON.stringify(body) });
    expect(await (await request("/history/import", "POST", importBody)).json()).toEqual({ added: 1, skipped: 0 });
    expect(await (await request("/history/import", "POST", importBody)).json()).toEqual({ added: 0, skipped: 1 });
    expect((await request("/songs/1", "PATCH", { title: "دعوة الواليدة" })).status).toBe(200);
    expect((await request("/songs/1/archive", "POST", { archived: true })).status).toBe(200);
    const actions = (await db.collection("song_history").where("song_id", "==", "1").get()).docs.map((doc) => doc.get("action"));
    expect(actions).toEqual(expect.arrayContaining(["migrated", "edited", "archived"]));
  });

  it("paginates tied timestamps, checks scopes, persists an ack and rejects revocation", async () => {
    const db = services.db;
    const token = "dss_" + "a".repeat(43); // Public emulator fixture.
    const headers = { Authorization: "Bearer " + token };
    const ref = db.doc("api_clients/studio-test-client");
    await ref.set({ key_hash: hash(token), scopes: ["songs:read", "songs:ack"], revoked: false, name: "test" });
    const updated_at = "2026-01-02T00:00:00.000Z";
    await Promise.all(["partner-a", "partner-b", "partner-c"].map((key, index) =>
      db.doc("songs/" + key).set({ status: index < 2 ? "approved" : "draft", updated_at, number: index + 100 })));
    const first = await (await fetch(origin + "/api/v1/songs?status=approved&limit=1", { headers })).json() as {
      songs: { id: string }[]; next_cursor: string;
    };
    expect(first.songs.map((song) => song.id)).toEqual(["partner-a"]);
    const second = await (await fetch(origin + "/api/v1/songs?status=approved&limit=1&cursor=" + first.next_cursor,
      { headers })).json() as typeof first;
    expect(second.songs.map((song) => song.id)).toEqual(["partner-b"]);
    expect(second.next_cursor).toBeNull();
    expect((await fetch(origin + "/api/v1/songs/partner-a/audio?format=wav", { headers })).status).toBe(403);
    const ack = { system: "test", external_id: "example", result: "imported" };
    const submit = () => fetch(origin + "/api/v1/songs/partner-a/ack", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(ack),
    });
    expect((await submit()).status).toBe(200);
    expect((await submit()).status).toBe(200);
    const records = await db.collection("songs/partner-a/acknowledgements").get();
    expect(records.size).toBe(1);
    expect(records.docs[0].data()).toMatchObject(ack);
    await ref.update({ revoked: true });
    expect((await fetch(origin + "/api/v1/songs", { headers })).status).toBe(401);
  });
});
