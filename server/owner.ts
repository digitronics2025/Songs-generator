import { json, Router, type Request } from "express";
import { z } from "zod";
import type { FirebaseServices } from "./config.ts";
import { ownerAuth } from "./auth.ts";
import { assertLyrics, createSongs, importRecords, library, mutateSong, proposeDrafts, selectTake, serializeHistory } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import { generateTake, generationStatus } from "./generation.ts";
import { rateLimit } from "./limits.ts";
import { migrateCatalog } from "./migration.ts";
import { registerClientRoutes } from "./partner.ts";
import { batchLimit, editFields, empty, id, ids, importHistory, label, saveDraft, studioSettings } from "./schemas.ts";
import { readSettings } from "./settings.ts";
import { checkedObjectPath, downloadAudio, storagePathFromUrl } from "./storage.ts";

function emptyBody(req: Request) { empty.parse(req.body ?? {}); }
function emptyQuery(req: Request) { empty.parse(req.query); }

export function ownerRouter(services: FirebaseServices, emails: string[]) {
  const { auth, db, bucket } = services;
  const api = Router();
  api.use(ownerAuth((token) => auth.verifyIdToken(token, true), emails));
  api.use(json({ limit: "2mb", strict: true }));
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method === "HEAD" && req.path === "/storage-proxy") return next(new HttpError(405, "Use GET for studio audio."));
    next();
  });
  api.use(async (_req, res, next) => {
    await rateLimit(db, "owner", String(res.locals.uid), 120);
    next();
  });
  api.get("/session", (req, res) => {
    emptyQuery(req);
    emptyBody(req);
    res.json({ owner: true });
  });
  api.get("/library", async (req, res) => {
    emptyQuery(req);
    emptyBody(req);
    const [songs, settings, history] = await Promise.all([
      library(db, bucket.name), readSettings(db), db.collection("song_history").orderBy("timestamp", "desc").get(),
    ]);
    res.json({ songs, settings, history: history.docs.map(serializeHistory) });
  });
  api.put("/settings", async (req, res) => {
    emptyQuery(req);
    const settings = studioSettings.parse(req.body);
    await db.doc("settings/app_settings").set({
      ...settings, ownerId: res.locals.uid, updated_at: new Date().toISOString(),
    }, { merge: true });
    res.json({ saved: true });
  });
  api.post("/migrations/catalog", async (req, res) => {
    emptyQuery(req);
    const { dry_run } = z.object({ dry_run: z.boolean() }).strict().parse(req.body);
    res.json(await migrateCatalog(db, res.locals.uid, dry_run, bucket.name));
  });
  api.post("/history/import", async (req, res) => {
    emptyQuery(req);
    res.json(await importRecords(db, res.locals.uid, importHistory.parse(req.body)));
  });
  api.post("/songs", async (req, res) => {
    emptyQuery(req);
    const { drafts } = z.object({ drafts: z.array(saveDraft).min(1).max(batchLimit) }).strict().parse(req.body);
    await rateLimit(db, "paid", res.locals.uid, 8);
    const ids = await createSongs(db, await readSettings(db), res.locals.uid, drafts);
    res.status(201).json({ ids });
  });
  api.post("/songs/drafts", async (req, res) => {
    emptyQuery(req);
    const { feelings, count, idea } = z.object({
      feelings: z.array(label).min(1).max(30),
      count: z.number().int().min(1).max(batchLimit),
      idea: z.string().trim().max(500).default(""),
    }).strict().parse(req.body);
    await rateLimit(db, "paid", res.locals.uid, 8);
    const settings = await readSettings(db);
    if (feelings.some((feeling) => !settings.feelings.includes(feeling))) throw new HttpError(422, "Choose a studio feeling.");
    res.json(await proposeDrafts(db, settings, feelings, count, idea));
  });
  api.patch("/songs/:id", async (req, res) => {
    emptyQuery(req);
    const { id: songId } = ids.parse(req.params);
    const edits = editFields.parse(req.body);
    const settings = await readSettings(db);
    if (edits.admin_feeling && !settings.feelings.includes(edits.admin_feeling)) {
      throw new HttpError(422, "Choose a studio feeling.");
    }
    await mutateSong(db, songId, (song) => {
      if (edits.lines) assertLyrics({ lines: edits.lines }, settings);
      const lyricEdited = edits.title !== undefined && edits.title !== song.title ||
        edits.lines !== undefined && JSON.stringify(edits.lines) !== JSON.stringify(song.lines);
      return {
        patch: { ...edits, ...(lyricEdited ? {
          ...(song.archived ? { pre_archive_status: "draft" } : { status: "draft" }), proposed_lyric: null,
        } : {}) },
        action: "edited",
      };
    });
    res.json({ saved: true });
  });
  api.post("/songs/:id/archive", async (req, res) => {
    emptyQuery(req);
    const { id: songId } = ids.parse(req.params);
    const { archived } = z.object({ archived: z.boolean() }).strict().parse(req.body);
    await mutateSong(db, songId, (song) => {
      const wasArchived = Boolean(song.archived || song.status === "archived");
      if (wasArchived === archived) return { patch: {} };
      return {
        patch: archived ? {
          status: "archived", archived: true,
          pre_archive_status: song.status === "generating" ? "failed" : song.status ?? "draft",
        } : { status: song.pre_archive_status ?? "draft", archived: false },
        action: archived ? "archived" : "restored",
      };
    });
    res.json({ saved: true });
  });
  api.post("/songs/:id/approve-lyric", async (req, res) => {
    emptyQuery(req);
    emptyBody(req);
    const { id: songId } = ids.parse(req.params);
    const settings = await readSettings(db);
    await mutateSong(db, songId, (song) => {
      if (song.status !== "draft" || song.archived) throw new HttpError(409, "Only draft lyrics can be approved.");
      assertLyrics({ lines: song.lines }, settings);
      return { patch: { status: "lyric_approved", proposed_lyric: null }, action: "lyric_approved" };
    });
    res.json({ saved: true });
  });
  api.post("/songs/:id/takes/:take", async (req, res) => {
    emptyQuery(req);
    const params = z.object({ id, take: id }).strict().parse(req.params);
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    await selectTake(db, params.id, params.take, approve);
    res.json({ saved: true });
  });
  for (const mode of ["generate", "repair"] as const) {
    api.post("/songs/:id/" + mode, async (req, res) => {
      emptyQuery(req);
      emptyBody(req);
      const { id: songId } = ids.parse(req.params);
      await rateLimit(db, "paid", res.locals.uid, 8);
      res.json(await generateTake(services, songId, res.locals.uid, mode === "repair"));
    });
  }
  api.get("/songs/:id/job", async (req, res) => {
    emptyQuery(req);
    emptyBody(req);
    const { id: songId } = ids.parse(req.params);
    res.json(await generationStatus(db, songId));
  });
  api.get("/songs/:id/details", async (req, res) => {
    emptyQuery(req);
    emptyBody(req);
    const { id: songId } = ids.parse(req.params);
    const ref = db.doc("songs/" + songId);
    if (!(await ref.get()).exists) throw new HttpError(404, "Song not found.");
    const [repairs, acks] = await Promise.all([
      ref.collection("repair_logs").orderBy("timestamp", "desc").get(),
      ref.collection("acknowledgements").orderBy("received_at", "desc").get(),
    ]);
    res.json({ repairs: repairs.docs.map((doc) => doc.data()), acks: acks.docs.map((doc) => doc.data()) });
  });

  api.get("/storage-proxy", async (req, res) => {
    emptyBody(req);
    const input = z.union([
      z.object({ path: z.string().max(400) }).strict(),
      z.object({ url: z.string().max(2048) }).strict(),
    ]).parse(req.query);
    const path = "path" in input ? checkedObjectPath(input.path) : storagePathFromUrl(input.url, bucket.name);
    const audio = await downloadAudio(bucket, path);
    res.set("Content-Type", path.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg");
    res.send(audio);
  });
  api.all("/storage-proxy", (_req, res) => {
    res.set("Allow", "GET").status(405).json({ error: "Use GET for studio audio." });
  });
  registerClientRoutes(api, db);
  api.use((_req, _res, next) => next(new HttpError(404, "Studio endpoint not found.")));
  return api;
}
