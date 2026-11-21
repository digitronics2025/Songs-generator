import { randomUUID } from "node:crypto";
import type { DocumentData, Firestore } from "firebase-admin/firestore";
import type { SongTake } from "../src/data/songs.ts";
import { compareTranscriptInOrder } from "../src/lib/lyricQuality.ts";
import { audioFailures, decideRepairAction, repeatedExtras, type RepairLogEntry } from "../src/lib/songRepair.ts";
import { masterWav } from "./audio.ts";
import { assertLyrics, takeProjection } from "./catalog.ts";
import type { FirebaseServices } from "./config.ts";
import { HttpError } from "./errors.ts";
import { assertGeminiEnabled, Gemini } from "./gemini.ts";
import { checkBudget, checkGenerationLimits, dayKey, LEASE_MS } from "./limits.ts";
import { historyRecord, legacyTakes, lyricRevision } from "./migration.ts";
import { studioFields } from "./schemas.ts";
import { readSettings, musicModel } from "./settings.ts";
import { downloadAudio } from "./storage.ts";

const blank: Pick<SongTake, "duration_seconds" | "lufs" | "true_peak_db" | "words_heard_pct" |
  "voice_start" | "voice_end" | "missing_words" | "extra_words"> = {
  duration_seconds: null, lufs: null, true_peak_db: null, words_heard_pct: null,
  voice_start: null, voice_end: null, missing_words: [], extra_words: [],
};

const date = () => new Date().toISOString();
const leasePath = (id: string) => "studio_locks/" + id;
export function ownsLease(data: DocumentData | undefined, token: string, now = Date.now()) {
  return data?.token === token && data.expires_at > now;
}

export async function generateTake(services: FirebaseServices, id: string, uid: string, repair: boolean) {
  const { db, bucket } = services;
  const ref = db.doc("songs/" + id);
  const lock = db.doc(leasePath(id));
  const token = randomUUID();
  const settings = await readSettings(db);
  const model = musicModel(settings.default_model);
  const logs: RepairLogEntry[] = [];
  let cost = 0;
  const note = (check: string, changed: string, result: string) => logs.push({
    id: randomUUID(), timestamp: date(), check_failed: check, what_was_changed: changed, result, estimated_cost: cost,
  });
  const claimed = await db.runTransaction(async (tx) => {
    const [songDoc, lease, takeDocs, usage] = await Promise.all([
      tx.get(ref), tx.get(lock), tx.get(ref.collection("takes").orderBy("take_number")),
      tx.get(db.doc("studio_usage/" + dayKey())),
    ]);
    const song = songDoc.data();
    if (!song) throw new HttpError(404, "Song not found.");
    if (song.archived || song.status === "archived") throw new HttpError(409, "Restore the song before generating.");
    if (repair ? !["failed", "generating"].includes(song.status) :
        !["lyric_approved", "ready", "approved", "failed", "needs_person", "generating"].includes(song.status)) {
      throw new HttpError(409, "Approve the lyric before generating.");
    }
    const parsed = studioFields.safeParse({
      title: song.title, lines: song.lines, admin_feeling: song.admin_feeling, feeling_key: song.feeling_key,
      theme: song.theme, mood: song.mood, tempo_bpm: song.tempo_bpm, instruments: song.instruments,
      vocal_tone: song.vocal_tone,
    });
    if (!parsed.success) throw new HttpError(422, "The song is missing required generation fields. Run the catalog migration or edit the song.");
    const spec = parsed.data;
    if (!repair) assertLyrics(spec, settings);
    const takes = takeDocs.docs.map((doc) => doc.data() as SongTake);
    const legacy = legacyTakes(song, date()).filter((take) => !takes.some((item) =>
      item.id === take.id || (take.storage_path && item.storage_path === take.storage_path)));
    const all = [...takes, ...legacy];
    const now = Date.now();
    const day = dayKey(now);
    const automatic = song.last_take_date === day ? (song.automatic_takes_today ?? 0) : 0;
    const lyric = lyricRevision(spec.title, spec.lines);
    const matching = takes.filter((take) => take.lyric_revision === lyric && take.status !== "generating");
    const repairAction = repair ? decideRepairAction(spec, matching, settings) : null;
    const last = matching.filter((take) => take.storage_path?.endsWith(".wav")).at(-1);
    const createsTake = repairAction?.type !== "REQUEST_LYRIC_FIX" && repairAction?.type !== "NONE";
    checkGenerationLimits(lease.data(), createsTake ? all.length : 0, repair ? automatic : 0, now);
    if (repairAction?.type !== "REMASTER" && repairAction?.type !== "NONE") {
      assertGeminiEnabled();
      const minimum = repairAction?.type === "REQUEST_LYRIC_FIX" ? 45_000 :
        (model === "lyria-3-clip-preview" ? 40_000 : 80_000) + 60_000;
      checkBudget(usage.get("reserved_micros") ?? 0, minimum, Math.floor(settings.daily_budget_usd * 1_000_000));
    }
    for (const doc of takeDocs.docs) {
      if (doc.get("status") === "generating") tx.update(doc.ref, { status: "failed", failure_reasons: ["EXPIRED_JOB"] });
    }
    if (repairAction?.type === "NONE") {
      if (last) tx.update(ref, { ...takeProjection(last), status: "ready", updated_at: date() });
      return null;
    }
    const takeRef = createsTake ? ref.collection("takes").doc(token) : null;
    if (takeRef) tx.create(takeRef, {
      ...blank,
      id: token, take_number: Math.max(0, ...all.map((take) => take.take_number || 0)) + 1,
      model: repairAction?.type === "REMASTER" ? last?.model ?? model : model,
      ownerId: uid, created_at: date(), storage_path: null, cost_estimate: 0, status: "generating",
      lyric_revision: lyric, is_approved: false,
    });
    tx.set(lock, { token, expires_at: now + LEASE_MS });
    tx.update(ref, {
      status: song.status === "approved" ? "approved" : "generating",
      updated_at: date(), ...(repair ? { automatic_takes_today: automatic + 1, last_take_date: day } : {}),
    });
    return { spec, takeRef, repairAction, last, song, lyric };
  });
  if (!claimed) return { status: "ready" };

  const { spec, takeRef, repairAction, last, song } = claimed;
  const gemini = new Gemini(db, (status) => note(String(status), "Retry with backoff", "Retried"), (micros) => { cost += micros / 1_000_000; });
  const folder = "songs/takes/" + id + "/" + token;
  const isRemaster = repairAction?.type === "REMASTER";
  let storage: string | null = null;
  let rawPath: string | null = null;
  let metrics: typeof blank & { transcribed_text?: string; repeated_words?: string[] } = blank;
  let failure: unknown;
  let suggested: { title: string; lines: string[]; reason: string; created_at: string } | null = null;
  try {
    if (repairAction?.type === "REQUEST_LYRIC_FIX") {
      const draft = await gemini.draft(spec.admin_feeling, JSON.stringify({
        title: spec.title, lines: spec.lines, correction: repairAction.reason,
      }), settings, []);
      assertLyrics(draft, settings);
      suggested = { title: draft.title, lines: draft.lines, reason: repairAction.reason, created_at: date() };
      note(repairAction.reason, "Rewrote the lyric", "Draft awaiting approval");
    } else {
      const tempo = repairAction?.type === "NEW_TAKE" ? repairAction.tempo : spec.tempo_bpm;
      const directive = repairAction?.type === "NEW_TAKE" ? repairAction.directive :
        "Start singing within one second and finish by second 27. Sing each line exactly once.";
      const raw = isRemaster
        ? await downloadAudio(bucket, last!.storage_path!)
        : await gemini.music(model, [
          "Moroccan Darija acoustic song. Length about " + settings.target_length + " seconds.",
          directive, "Theme: " + spec.theme, "Mood: " + spec.mood,
          "Tempo: " + tempo, "Instruments: " + spec.instruments, "Voice: " + spec.vocal_tone,
          "Use clear, dry solo vocals with soft accompaniment. Exact lyrics:", ...spec.lines,
        ].join("\n"));
      if (!isRemaster) {
        const rawObject = folder + "-source.mp3";
        await bucket.file(rawObject).save(raw, { resumable: false, contentType: "audio/mpeg", preconditionOpts: { ifGenerationMatch: 0 } });
        rawPath = rawObject;
        await takeRef?.update({ raw_storage_path: rawPath });
      }
      let master = await masterWav(raw, settings.target_length, isRemaster);
      if (!isRemaster && (master.lufs < -15 || master.lufs > -13 || master.true_peak_db > -1)) {
        master = await masterWav(raw, settings.target_length, true);
        note("Loudness or peak", "Re-mastered original audio", "Measured the new WAV");
      }
      const main = folder + ".wav";
      await bucket.file(main).save(master.wav, { resumable: false, contentType: "audio/wav", preconditionOpts: { ifGenerationMatch: 0 } });
      storage = main;
      await takeRef?.update({ storage_path: storage });
      metrics = {
        ...blank, duration_seconds: master.duration_seconds, lufs: master.lufs, true_peak_db: master.true_peak_db,
      };
      if (isRemaster && last) {
        const { words_heard_pct, voice_start, voice_end, missing_words, extra_words, repeated_words, transcribed_text } = last;
        metrics = { ...metrics, words_heard_pct, voice_start, voice_end, missing_words, extra_words,
          repeated_words: repeated_words ?? [], transcribed_text: transcribed_text ?? "" };
      } else {
        const analysis = await gemini.transcribe(master.wav, master.duration_seconds);
        const report = compareTranscriptInOrder(spec.lines, analysis.transcript);
        metrics = { ...metrics, ...report, voice_start: analysis.voice_start, voice_end: analysis.voice_end,
          repeated_words: repeatedExtras(report.extra_words, spec.lines) };
      }
    }
  } catch (error) {
    failure = error;
  }

  const failures = suggested ? [] : [...audioFailures(metrics), ...(failure ? ["PROCESSING_ERROR"] : [])];
  const success = !failure && !failures.length && Boolean(storage);
  const status = suggested ? "draft" : success ? "ready" : "failed";
  if (repairAction || failures.length) {
    note(repairAction?.reason ?? failures.join(", "), repairAction?.type ?? "Generated a take",
      failure instanceof HttpError ? failure.message : status);
  }

  await db.runTransaction(async (tx) => {
    const [lease, current, take, revision] = await Promise.all([
      tx.get(lock), tx.get(ref), takeRef ? tx.get(takeRef) : null, tx.get(db.doc("studio_meta/catalog")),
    ]);
    if (!ownsLease(lease.data(), token)) throw new HttpError(409, "The song generation lease expired.");
    const updatedAt = date();
    const takeData = { ...take?.data(), ...metrics, storage_path: storage, raw_storage_path: rawPath,
      status: success ? "ready" : "failed", failure_reasons: failures,
      passed_all_checks: success, cost_estimate: cost };
    if (takeRef) tx.update(takeRef, takeData);
    const wasApproved = song.status === "approved";
    const promote = storage && (success || !current.get("storage_path")) && !wasApproved;
    const patch = {
      ...(promote ? takeProjection(takeData) : {}),
      ...(suggested ? { title: suggested.title, lines: suggested.lines, proposed_lyric: suggested } : {}),
      status: wasApproved ? "approved" : status,
      error_message: failure instanceof HttpError ? failure.message : failure ? "Audio processing failed." : null,
      updated_at: updatedAt,
    };
    tx.update(ref, patch);
    if (suggested) {
      const historyId = "repair_" + token;
      tx.create(db.doc("song_history/" + historyId), historyRecord(historyId, id, { ...song, ...patch }, "edited", updatedAt));
      tx.set(db.doc("studio_meta/catalog"), { version: (revision.get("version") ?? 0) + 1 }, { merge: true });
    }
    for (const log of logs) tx.create(ref.collection("repair_logs").doc(log.id), log);
    tx.set(lock, { token, expires_at: 0 });
  });

  if (failure instanceof HttpError) throw failure;
  if (failure) throw new HttpError(502, "Audio processing failed. The take and repair log have been recorded.");
  return { status: song.status === "approved" ? "approved" : status, take_id: takeRef?.id ?? null };
}

export async function generationStatus(db: Firestore, id: string) {
  const [song, lock] = await db.getAll(db.doc("songs/" + id), db.doc(leasePath(id)));
  if (!song.exists) throw new HttpError(404, "Song not found.");
  return { generating: (lock.get("expires_at") ?? 0) > Date.now(), status: song.get("status") };
}
