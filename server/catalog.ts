import { randomUUID } from "node:crypto";
import type { DocumentData, Firestore, QueryDocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { formatSongFilename, INITIAL_SONGS, type StudioSettings } from "../src/data/songs.ts";
import { closestLyric, type LyricText } from "../src/lib/duplicates.ts";
import { validateLyrics } from "../src/lib/lyricQuality.ts";
import { autopilotTakeQualifies } from "./autopilotQuality.ts";
import { HttpError } from "./errors.ts";
import { Gemini } from "./gemini.ts";
import { checkAutopilotAllowance, hash, type AutopilotBudget } from "./limits.ts";
import { historyRecord, legacyTakes, lyricRevision } from "./migration.ts";
import { batchLimit, type Draft, type SaveDraft, type importHistory } from "./schemas.ts";
import type { z } from "zod";

const revisionPath = "studio_meta/catalog";
const historyCollection = "song_history";
const versionOf = (data?: DocumentData) => data?.version ?? 0;

export async function library(db: Firestore, bucket?: string) {
  const snapshot = await db.collection("songs").get();
  const songs = await Promise.all(snapshot.docs.map(async (doc) => {
    const data = doc.data();
    const takes = await doc.ref.collection("takes").orderBy("take_number").get();
    const legacy = legacyTakes(data, data.updated_at ?? "", bucket);
    const current = takes.docs.map((take) => take.data());
    for (const take of legacy) {
      if (!current.some((item) => item.id === take.id ||
          (take.storage_path && item.storage_path === take.storage_path))) current.push(take);
    }
    return {
      ...data, id: doc.id,
      number: data.number ?? (Number(doc.id) || 0),
      title: typeof data.title === "string" ? data.title : "",
      lines: Array.isArray(data.lines) ? data.lines.filter((line) => typeof line === "string") : [],
      feeling_key: data.feeling_key ?? "unset",
      theme: data.theme ?? "", mood: data.mood ?? "",
      tempo_bpm: data.tempo_bpm ?? 80, instruments: data.instruments ?? "", vocal_tone: data.vocal_tone ?? "",
      created_at: data.created_at ?? "", updated_at: data.updated_at ?? "",
      archived: Boolean(data.archived || data.status === "archived"),
      storage_path: data.storage_path ?? legacy.find((take) => take.storage_path)?.storage_path ?? null,
      admin_feeling: data.admin_feeling || "unset",
      status: data.archived ? "archived" : data.status || "unset",
      takes: current,
      // Legacy Firebase download URLs may carry durable access tokens.
      download_url: null,
    };
  }));
  return songs.sort((a, b) => a.number - b.number).map((song) => ({
    ...song,
    takes: song.takes.map((take) => ({ ...take, download_url: null })),
  }));
}

async function historyText(db: Firestore): Promise<LyricText[]> {
  const [history, songs] = await Promise.all([db.collection(historyCollection).get(), db.collection("songs").get()]);
  const texts = new Map<string, LyricText>();
  for (const doc of [...history.docs, ...songs.docs]) {
    const title = doc.get("title");
    const lines = doc.get("lines");
    if (typeof title !== "string" || !Array.isArray(lines) || !lines.every((line) => typeof line === "string")) continue;
    texts.set(lyricRevision(title, lines), { title, lines });
  }
  return [...texts.values()];
}

async function addEmbeddings(db: Firestore, gemini: Gemini, texts: LyricText[]) {
  const unique = new Map<string, LyricText[]>();
  for (const text of texts) {
    const digest = lyricRevision(text.title, text.lines);
    unique.set(digest, [...(unique.get(digest) ?? []), text]);
  }
  const entries = [...unique];
  for (let index = 0; index < entries.length; index += batchLimit) {
    const chunk = entries.slice(index, index + batchLimit);
    const refs = chunk.map(([digest]) => db.doc("studio_embeddings/v1_" + digest));
    const docs = await db.getAll(...refs);
    const missing = chunk.filter((_, i) => !docs[i].exists);
    const values = missing.length ? await gemini.embed(missing.map(([, [text]]) =>
      [text.title, ...text.lines].join("\n")
    )) : [];
    const store = db.batch();
    let next = 0;
    for (const [i, [digest, group]] of chunk.entries()) {
      const saved = docs[i].get("values") as number[] | undefined;
      const embedding = saved ?? values[next++];
      for (const text of group) text.embedding = embedding;
      if (!saved) store.set(db.doc("studio_embeddings/v1_" + digest), { values: embedding });
    }
    if (missing.length) await store.commit();
  }
}

export function assertLyrics(draft: { lines: string[] }, settings: StudioSettings) {
  const check = validateLyrics(draft.lines, settings);
  if (!check.valid) throw new HttpError(422, check.errors.join(" "));
}

export async function proposeDrafts(
  db: Firestore, settings: StudioSettings, feelings: string[], count: number, idea: string, budget?: AutopilotBudget,
) {
  const gemini = new Gemini(db, undefined, undefined, budget);
  const history = await historyText(db);
  const drafts: Array<Draft & { closest_match_pct: number; validation: { valid: boolean; errors: string[] } }> = [];
  const failures: string[] = [];
  const deadline = Date.now() + 160_000;
  attempts: for (let i = 0; i < count; i++) {
    const avoid = [...history, ...drafts].slice(-6).map((entry) => entry.title);
    let rhymeRetried = false;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (Date.now() >= deadline) { failures.push("Drafting timed out. Generate the remaining drafts separately."); break attempts; }
      let draft: Draft;
      let budgetReached = false;
      try {
        draft = await gemini.draft(feelings[i % feelings.length], idea, settings, avoid);
        assertLyrics(draft, { ...settings, rhyme_scheme: "OFF" });
        let validation = validateLyrics(draft.lines, settings);
        if (!validation.valid && !rhymeRetried && Date.now() < deadline) {
          rhymeRetried = true;
          try {
            draft = await gemini.draft(feelings[i % feelings.length], idea, settings, avoid, draft);
            validation = validateLyrics(draft.lines, settings);
          } catch (error) {
            if (!(error instanceof HttpError) || ![422, 429].includes(error.status)) throw error;
            if (error.status === 429) { failures.push(error.message); budgetReached = true; }
          }
        }
        if (!validation.valid) {
          drafts.push({ ...draft, closest_match_pct: closestLyric(draft, [...history, ...drafts]).closest_match_pct, validation });
          if (budgetReached) break attempts;
          break;
        }
      } catch (error) {
        if (error instanceof HttpError && error.status === 422) {
          if (attempt === 3) failures.push("Draft " + (i + 1) + " did not pass lyric validation.");
          continue;
        }
        if (drafts.length && error instanceof HttpError && error.status === 429) {
          return { drafts, failures: [...failures, error.message] };
        }
        throw error;
      }
      const prior = [...history, ...drafts];
      if (!closestLyric(draft, prior).rejected) {
        try {
          await addEmbeddings(db, gemini, [...prior, draft]);
        } catch (error) {
          if (drafts.length && error instanceof HttpError && error.status === 429) {
            return { drafts, failures: [...failures, error.message] };
          }
          throw error;
        }
        const match = closestLyric(draft as LyricText, prior);
        if (!match.rejected) {
          const embedded = (draft as LyricText).embedding;
          drafts.push({ ...draft, ...match, validation: { valid: true, errors: [] }, ...(embedded ? { embedding: embedded } : {}) });
          break;
        }
      }
      avoid.push(draft.title);
      if (attempt === 3) failures.push("Draft " + (i + 1) + " remained too similar after three rewrites.");
    }
  }
  if (!drafts.length) throw new HttpError(422, failures.join(" ") || "No original drafts were produced.");
  return { drafts: drafts.map(({ title, lines, admin_feeling, feeling_key, theme, mood, tempo_bpm, instruments,
    vocal_tone, closest_match_pct, validation }) => ({ title, lines, admin_feeling, feeling_key, theme, mood,
    tempo_bpm, instruments, vocal_tone, closest_match_pct, validation })), failures };
}

export async function checkRepairLyric(db: Firestore, draft: Draft, budget: AutopilotBudget) {
  const version = versionOf((await db.doc(revisionPath).get()).data());
  const history = await historyText(db);
  if (closestLyric(draft, history).rejected) throw new HttpError(409, "The repaired lyric matches song history.");
  await addEmbeddings(db, new Gemini(db, undefined, undefined, budget), [...history, draft]);
  if (closestLyric(draft, history).rejected) throw new HttpError(409, "The repaired lyric matches song history.");
  return version;
}

export async function createSongs(db: Firestore, settings: StudioSettings, uid: string, drafts: SaveDraft[],
  budget?: AutopilotBudget, replacementFor?: string) {
  for (const draft of drafts) assertLyrics(draft, settings);
  const rev = db.doc(revisionPath);
  const initial = await rev.get();
  const history = await historyText(db);
  await addEmbeddings(db, new Gemini(db, undefined, undefined, budget), [...history, ...drafts]);
  const now = new Date().toISOString();
  const matches = drafts.map((draft, index) => {
    const match = closestLyric(draft, [...history, ...drafts.slice(0, index)]);
    if (match.rejected) throw new HttpError(409, "A draft matches song history (" + match.closest_match_pct + "%).");
    return match.closest_match_pct;
  });
  return db.runTransaction(async (tx) => {
    const current = await tx.get(rev);
    if (versionOf(initial.data()) !== versionOf(current.data())) {
      throw new HttpError(409, "Song history changed. Save again to recheck for duplicates.");
    }
    const latest = await tx.get(db.collection("songs").orderBy("number", "desc").limit(1));
    const runRef = budget ? db.doc(budget.path) : null;
    const oldSongRef = replacementFor ? db.doc("songs/" + replacementFor) : null;
    if (runRef && budget) {
      const [run, currentSettings] = await tx.getAll(runRef, db.doc("settings/app_settings"));
      checkAutopilotAllowance(run, currentSettings, budget, 0);
      const cap = Math.min(run.get("max_new_songs"), currentSettings.get("autopilot.max_new_songs"));
      if (run.get("drafted") + drafts.length > cap) throw new HttpError(409, "The Autopilot daily new-song limit has been reached.");
      if (oldSongRef) {
        const oldSong = await tx.get(oldSongRef);
        if (drafts.length !== 1 || oldSong.get("status") !== "archived" || !oldSong.get("autopilot_replacement_pending") ||
            oldSong.get("admin_feeling") !== drafts[0].admin_feeling) {
          throw new HttpError(409, "This archived lyric no longer needs a replacement.");
        }
      }
      tx.update(runRef, { drafted: run.get("drafted") + drafts.length });
    }
    const first = Math.max(latest.docs[0]?.get("number") ?? 0, INITIAL_SONGS.length) + 1;
    const ids: string[] = [];
    for (const [index, draft] of drafts.entries()) {
      const id = randomUUID();
      ids.push(id);
      const number = first + index;
      const { title, lines, admin_feeling, feeling_key, theme, mood, tempo_bpm, instruments, vocal_tone } = draft;
      const song = {
        title, lines, admin_feeling, feeling_key, theme, mood, tempo_bpm, instruments, vocal_tone,
        id, number, status: draft.isApproved ? "lyric_approved" : "draft", ownerId: uid, created_at: now, updated_at: now, archived: false,
        best_take_id: null, file_name: formatSongFilename(number, feeling_key), closest_match_pct: matches[index],
      };
      const historyId = "created_" + id;
      tx.create(db.doc("songs/" + id), song);
      tx.create(db.doc(historyCollection + "/" + historyId), historyRecord(historyId, id, song, "created", now));
    }
    if (oldSongRef) tx.update(oldSongRef, { autopilot_replacement_pending: false, autopilot_replacement_id: ids[0] });
    tx.set(rev, { version: versionOf(current.data()) + 1 }, { merge: true });
    return ids;
  });
}

type SongMutation = { patch: DocumentData; action?: string } | null;

export async function mutateSong(
  db: Firestore, id: string, fn: (song: DocumentData, tx: Transaction) => SongMutation | Promise<SongMutation>,
) {
  const ref = db.doc("songs/" + id);
  const rev = db.doc(revisionPath);
  const now = new Date().toISOString();
  const historyId = randomUUID();
  return db.runTransaction(async (tx) => {
    const [current, revision, lease] = await tx.getAll(ref, rev, db.doc("studio_locks/" + id));
    const song = current.data();
    if (!song) throw new HttpError(404, "Song not found.");
    if ((lease.get("expires_at") ?? 0) > Date.now()) throw new HttpError(409, "This song is generating.");
    const result = await fn(song, tx);
    if (!result) return false;
    const { action, patch } = result;
    tx.update(ref, { ...patch, updated_at: now });
    if (action) {
      tx.create(db.doc(historyCollection + "/" + historyId), {
        ...historyRecord(historyId, id, { ...song, ...patch }, action, now),
        ...(action === "archived" && typeof patch.archive_reason === "string" ? { archive_reason: patch.archive_reason } : {}),
      });
      tx.set(rev, { version: versionOf(revision.data()) + 1 }, { merge: true });
    }
    return true;
  });
}

export function takeProjection(take: DocumentData) {
  return {
    best_take_id: take.id,
    storage_path: take.storage_path ?? null,
    model_used: take.model ?? null,
    generated_at: take.created_at ?? null,
    duration_seconds: take.duration_seconds ?? null,
    lufs: take.lufs ?? null, true_peak_db: take.true_peak_db ?? null,
    words_heard_pct: take.words_heard_pct ?? null, transcribed_text: take.transcribed_text ?? null,
    missing_words: take.missing_words ?? [], extra_words: take.extra_words ?? [],
    voice_start_seconds: take.voice_start ?? null, voice_end_seconds: take.voice_end ?? null,
  };
}

export async function selectTake(db: Firestore, id: string, takeId: string, approve: boolean, budget?: AutopilotBudget) {
  const ref = db.doc("songs/" + id);
  const take = ref.collection("takes").doc(takeId);
  return db.runTransaction(async (tx) => {
    const [song, target, lease] = await tx.getAll(ref, take, db.doc("studio_locks/" + id));
    if (budget) {
      if (song.get("status") === "approved") return false;
      const [run, settings] = await tx.getAll(db.doc(budget.path), db.doc("settings/app_settings"));
      checkAutopilotAllowance(run, settings, budget, 0);
    }
    if (song.get("archived")) throw new HttpError(409, "Restore this song before selecting a take.");
    if ((lease.get("expires_at") ?? 0) > Date.now()) throw new HttpError(409, "This song is generating.");
    if (!song.exists || !target.exists) throw new HttpError(404, "Song or take not found.");
    const data = target.data()!;
    if (data.status !== "ready" || !data.storage_path ||
        data.lyric_revision !== lyricRevision(song.get("title"), song.get("lines")) ||
        (approve && !data.passed_all_checks) || (budget && !autopilotTakeQualifies(data))) {
      throw new HttpError(409, "Approval requires a take for the current lyric that passed every quality check.");
    }
    if (approve && !data.is_approved) tx.update(take, {
      is_approved: true, approved_at: new Date().toISOString(), ...(budget ? { auto_approved: true } : {}),
    });
    const approved = approve || data.is_approved === true;
    tx.update(ref, {
      ...takeProjection(data), status: approved ? "approved" : "ready",
      auto_approved: approved && Boolean(budget || data.auto_approved),
      approved_take_id: approve ? takeId : song.get("approved_take_id") ?? null,
      updated_at: new Date().toISOString(),
    });
    return true;
  });
}

export async function importRecords(db: Firestore, uid: string, records: z.infer<typeof importHistory>) {
  const now = new Date().toISOString();
  const rev = db.doc(revisionPath);
  const unique = new Map(records.map((record) => [hash(record.source + "\0" + record.id), record]));
  let added = 0;
  const entries = [...unique];
  for (let i = 0; i < entries.length; i += 200) {
    const slice = entries.slice(i, i + 200);
    added += await db.runTransaction(async (tx) => {
      const refs = slice.map(([digest]) => db.doc(historyCollection + "/import_" + digest));
      const [current, ...existing] = await tx.getAll(rev, ...refs);
      let inserted = 0;
      for (const [index, ref] of refs.entries()) {
        if (existing[index].exists) continue;
        const [, record] = slice[index];
        tx.create(ref, {
          ...historyRecord(ref.id, record.id, { ...record, admin_feeling: record.feeling, ownerId: uid }, "imported", now),
          source: record.source,
        });
        inserted++;
      }
      if (inserted) tx.set(rev, { version: versionOf(current.data()) + 1 }, { merge: true });
      return inserted;
    });
  }
  return { added, skipped: records.length - added };
}

export function serializeHistory(snapshot: QueryDocumentSnapshot) {
  const { id, song_id, song_number, title, lines, admin_feeling, action, timestamp, source } = snapshot.data();
  return { id, song_id, song_number, title, lines, admin_feeling, action, timestamp, source };
}
