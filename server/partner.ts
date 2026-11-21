import { randomUUID } from "node:crypto";
import { json, Router, type RequestHandler } from "express";
import { FieldPath, type DocumentData, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { bearer } from "./auth.ts";
import type { FirebaseServices } from "./config.ts";
import { HttpError } from "./errors.ts";
import { hash } from "./limits.ts";
import { empty, id, ids } from "./schemas.ts";
import { signedAudio } from "./storage.ts";
import { lyricRevision } from "./migration.ts";

const clients = "api_clients";
const scopes = z.enum(["songs:read", "songs:audio", "songs:ack"]);
const apiKey = /^dss_[a-zA-Z0-9_-]{43}$/;
const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const listQuery = z.object({
  status: z.literal("approved").default("approved"),
  updated_since: isoDate.optional(),
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(50)).optional().default(50),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,600}$/).optional(),
}).strict();
const cursorData = z.object({ t: isoDate, id, since: isoDate.nullable() }).strict();
const name = z.string().trim().min(1).max(80);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const register = z.object({ name, key_hash: fingerprint, scopes: z.array(scopes).min(1).max(3) }).strict();

export function encodeCursor(t: string, key: string, since?: string) {
  return Buffer.from(JSON.stringify({ t, id: key, since: since ?? null })).toString("base64url");
}

export function decodeCursor(value: string, since?: string) {
  try {
    const data = cursorData.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (data.since !== (since ?? null)) throw new Error("Mismatched filter");
    return data;
  } catch {
    throw new HttpError(400, "Invalid pagination cursor.");
  }
}

export function encodePartnerSong(songId: string, song: DocumentData) {
  return {
    id: songId, number: song.number ?? null, title: song.title ?? "", lines: song.lines ?? [],
    admin_feeling: song.admin_feeling || "unset", feeling_key: song.feeling_key ?? null,
    theme: song.theme ?? null, mood: song.mood ?? null, tempo_bpm: song.tempo_bpm ?? null,
    words_heard_pct: song.words_heard_pct ?? null, voice_start: song.voice_start_seconds ?? null,
    voice_end: song.voice_end_seconds ?? null, duration_seconds: song.duration_seconds ?? null,
    lufs: song.lufs ?? null, true_peak_db: song.true_peak_db ?? null,
    best_take_id: song.best_take_id ?? null, updated_at: song.updated_at,
  };
}

function authenticate(db: Firestore): RequestHandler {
  return async (req, res, next) => {
    const token = bearer(req.get("authorization"));
    if (!apiKey.test(token)) throw new HttpError(401, "Invalid partner API key.");
    const digest = hash(token);
    const found = await db.collection(clients).where("key_hash", "==", digest).limit(1).get();
    const client = found.docs[0];
    if (!client) throw new HttpError(401, "Invalid partner API key.");
    res.locals.clientId = client.id;
    res.locals.scopes = await db.runTransaction(async (tx) => {
      const current = await tx.get(client.ref);
      if (current.get("revoked") !== false || current.get("key_hash") !== digest) {
        throw new HttpError(401, "Invalid partner API key.");
      }
      const now = Date.now();
      const requests: number[] = (current.get("requests") ?? []).filter((time: number) => now - time < 60_000);
      if (requests.length >= 60) {
        res.set("Retry-After", "60");
        throw new HttpError(429, "Partner API rate limit exceeded.");
      }
      tx.update(client.ref, { last_used_at: new Date(now).toISOString(), requests: [...requests, now] });
      return current.get("scopes");
    });
    next();
  };
}

function requireScope(scope: z.infer<typeof scopes>): RequestHandler {
  return (_req, res, next) => {
    if (!Array.isArray(res.locals.scopes) || !res.locals.scopes.includes(scope)) {
      throw new HttpError(403, "The partner key is missing the required scope.");
    }
    next();
  };
}

export function partnerRouter({ db, bucket }: FirebaseServices) {
  const api = Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const started = Date.now();
    const endpoint = req.path === "/songs" ? "songs" :
      req.path.endsWith("/audio") ? "audio" : req.path.endsWith("/ack") ? "ack" : "unknown";
    res.once("finish", () => {
      console.info(JSON.stringify({ event: "partner_api", endpoint, method: req.method, status: res.statusCode,
        client_id: res.locals.clientId ?? null, elapsed_ms: Date.now() - started }));
    });
    next();
  });
  api.use(authenticate(db));
  api.use(json({ limit: "16kb", strict: true }));
  api.get("/songs", requireScope("songs:read"), async (req, res) => {
    empty.parse(req.body ?? {});
    const filter = listQuery.parse(req.query);
    let query = db.collection("songs").where("status", "==", filter.status)
      .orderBy("updated_at", "asc").orderBy(FieldPath.documentId(), "asc");
    if (filter.updated_since) query = query.where("updated_at", ">", filter.updated_since);
    if (filter.cursor) {
      const cursor = decodeCursor(filter.cursor, filter.updated_since);
      query = query.startAfter(cursor.t, cursor.id);
    }
    const docs = (await query.limit(filter.limit + 1).get()).docs;
    const songs = docs.slice(0, filter.limit).map((doc) => encodePartnerSong(doc.id, doc.data()));
    const last = songs.at(-1);
    const next_cursor = last && docs.length > filter.limit
      ? encodeCursor(last.updated_at, last.id, filter.updated_since) : null;
    res.json({ songs, next_cursor });
  });
  api.get("/songs/:id/audio", requireScope("songs:audio"), async (req, res) => {
    const { id: songId } = ids.parse(req.params);
    empty.parse(req.body ?? {});
    const { format } = z.object({ format: z.enum(["wav", "mp3"]) }).strict().parse(req.query);
    const song = await db.doc("songs/" + songId).get();
    const best = id.safeParse(song.get("best_take_id"));
    if (song.get("status") !== "approved" || song.get("archived") || !best.success) {
      throw new HttpError(404, "Approved song audio not found.");
    }
    const take = await song.ref.collection("takes").doc(best.data).get();
    const path = take.get("storage_path");
    if (!take.get("is_approved") || typeof path !== "string" ||
        take.get("lyric_revision") !== lyricRevision(song.get("title"), song.get("lines"))) {
      throw new HttpError(404, "Approved song audio not found.");
    }
    res.json(await signedAudio(bucket, path, format));
  });
  api.post("/songs/:id/ack", requireScope("songs:ack"), async (req, res) => {
    const { id: songId } = ids.parse(req.params);
    empty.parse(req.query);
    const payload = z.object({
      system: z.string().trim().min(1).max(80), external_id: z.string().trim().min(1).max(160),
      result: z.enum(["imported", "rejected"]), reason: z.string().trim().max(400).optional(),
    }).strict().parse(req.body);
    const song = db.doc("songs/" + songId);
    const clientId = String(res.locals.clientId);
    const key = hash(JSON.stringify([clientId, payload.system, payload.external_id]));
    await db.runTransaction(async (tx) => {
      const current = await tx.get(song);
      if (current.get("status") !== "approved" || current.get("archived")) throw new HttpError(404, "Approved song not found.");
      tx.set(song.collection("acknowledgements").doc(key), {
        ...payload, reason: payload.reason ?? "", received_at: new Date().toISOString(), client_id: clientId,
      });
    });
    res.json({ saved: true });
  });
  api.use((_req, _res, next) => next(new HttpError(404, "Partner endpoint not found.")));
  return api;
}

export function registerClientRoutes(api: Router, db: Firestore) {
  api.get("/clients", async (req, res) => {
    empty.parse(req.query);
    empty.parse(req.body ?? {});
    const snapshot = await db.collection(clients).orderBy("created_at", "desc").get();
    res.json({ clients: snapshot.docs.map((doc) => ({
      id: doc.id, name: doc.get("name"), scopes: doc.get("scopes"), created_at: doc.get("created_at"),
      last_used_at: doc.get("last_used_at") ?? null, revoked: doc.get("revoked"),
    })) });
  });
  api.post("/clients", async (req, res) => {
    empty.parse(req.query);
    const body = register.parse(req.body);
    const clientId = randomUUID();
    await db.runTransaction(async (tx) => {
      const unique = db.doc("studio_client_fingerprints/" + body.key_hash);
      if ((await tx.get(unique)).exists) throw new HttpError(409, "This partner fingerprint already exists.");
      tx.create(unique, { client_id: clientId });
      tx.create(db.doc(clients + "/" + clientId), {
        ...body, scopes: [...new Set(body.scopes)], created_at: new Date().toISOString(), last_used_at: null, revoked: false,
      });
    });
    res.status(201).json({ id: clientId });
  });
  api.patch("/clients/:id", async (req, res) => {
    const { id: key } = ids.parse(req.params);
    empty.parse(req.query);
    const patch = z.union([z.object({ name }).strict(), z.object({ revoked: z.literal(true) }).strict()]).parse(req.body);
    const ref = db.doc(clients + "/" + key);
    await db.runTransaction(async (tx) => {
      if (!(await tx.get(ref)).exists) throw new HttpError(404, "Partner client not found.");
      tx.update(ref, patch);
    });
    res.json({ saved: true });
  });
}
