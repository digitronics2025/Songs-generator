import { randomUUID } from "node:crypto";
import type { DocumentData, Firestore } from "firebase-admin/firestore";
import type { SongTake } from "../src/data/songs.ts";
import { compareTranscriptInOrder } from "../src/lib/lyricQuality.ts";
import { audioFailures, decideRepairAction, repeatedExtras, type GenerationStage, type RepairLogEntry } from "../src/lib/songRepair.ts";
import { masterWav } from "./ffmpeg.ts";
import { assertLyrics, takeProjection } from "./catalog.ts";
import type { FirebaseServices } from "./config.ts";
import { HttpError } from "./errors.ts";
import { audioHealth } from "./audioHealth.ts";
import { DATA_CONFIGURATION, firebaseDataUnavailable } from "./firebaseErrors.ts";
import { assertGeminiEnabled, Gemini } from "./gemini.ts";
import { logGenerationFailure } from "./generationFailure.ts";
import { checkBudget, checkGenerationLimits, dayKey, LEASE_MS } from "./limits.ts";
import { historyRecord, legacyTakes, lyricRevision } from "./migration.ts";
import { studioFields } from "./schemas.ts";
import { readSettings, musicModel } from "./settings.ts";
import { downloadAudio } from "./storage.ts";

type GenerationRequest = "generate" | "repair" | { checkVocals: string };

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

export async function generateTake(services: FirebaseServices, id: string, uid: string, request: GenerationRequest) {
  const { db, bucket } = services;
  const ref = db.doc("songs/" + id);
  const lock = db.doc(leasePath(id));
  const token = randomUUID();
  const repair = request === "repair";
  const checkTakeId = typeof request === "object" ? request.checkVocals : null;
  const logs: RepairLogEntry[] = [];
  let cost = 0;
  const note = (check: string, changed: string, result: string) => logs.push({
    id: randomUUID(), timestamp: date(), check_failed: check, what_was_changed: changed, result, estimated_cost: cost,
  });

  const claimed = await (async () => {
    const settings = await readSettings(db);
    const model = musicModel(settings.default_model);
    const tools = checkTakeId ? null : await audioHealth();
    return db.runTransaction(async (tx) => {
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
      const takes = takeDocs.docs.map((doc) => ({ ref: doc.ref, data: doc.data() as SongTake }));
      const legacy = legacyTakes(song, date()).filter((take) => !takes.some(({ data }) =>
        data.id === take.id || (take.storage_path && data.storage_path === take.storage_path)));
      const now = Date.now();
      const day = dayKey(now);
      const automatic = song.last_take_date === day ? (song.automatic_takes_today ?? 0) : 0;
      const lyric = lyricRevision(spec.title, spec.lines);
      const matching = takes.filter(({ data }) => data.lyric_revision === lyric);
      const repairCandidates = matching.map(({ data }) =>
        data.status === "generating" ? { ...data, status: "failed" as const } : data);
      const action = repair ? decideRepairAction(spec, repairCandidates, settings) : null;
      const source = action?.type === "REMASTER" ? matching[action.takeIndex] : null;
      const resume = checkTakeId ? matching.find((item) => item.ref.id === checkTakeId) :
        action?.type === "REMASTER" && action.source === "raw" ? source : null;
      const sourcePath = action?.type === "REMASTER"
        ? action.source === "raw" ? source?.data.raw_storage_path : source?.data.storage_path
        : null;
      const createsTake = !resume && !checkTakeId && !["REQUEST_LYRIC_FIX", "NONE", "AWAIT_VOCALS"].includes(action?.type ?? "");
      checkGenerationLimits(lease.data(), createsTake ? takes.length + legacy.length : 0, repair ? automatic : 0, now);
      if (checkTakeId && (!resume?.data.vocal_check_pending || !resume.data.storage_path || resume.data.is_approved)) {
        throw new HttpError(409, "This take does not have a pending vocal check for the current lyric.");
      }
      if (action?.type === "REMASTER" && (!sourcePath ||
          (action.source === "raw" && !sourcePath.startsWith("songs/takes/" + id + "/")))) {
        throw new HttpError(422, "The saved audio path for this take is invalid.");
      }
      if (action?.type === "NONE" || action?.type === "AWAIT_VOCALS") {
        const last = matching.map(({ data }) => data).reverse().find((take) => take.storage_path?.endsWith(".wav"));
        const status = action.type === "NONE" ? "ready" : "needs_person";
        tx.update(ref, { ...(last ? takeProjection(last) : {}), status, updated_at: date() });
        return { complete: status } as const;
      }
      if (!checkTakeId && action?.type !== "REQUEST_LYRIC_FIX" && !tools?.ffmpeg_master_test) {
        throw new HttpError(503, "FFmpeg mastering is unavailable. Check the FFmpeg setup diagnostics.");
      }
      if (action?.type !== "REMASTER") {
        assertGeminiEnabled();
        const minimum = checkTakeId ? 60_000 : action?.type === "REQUEST_LYRIC_FIX" ? 45_000 :
          (model === "lyria-3-clip-preview" ? 40_000 : 80_000) + 60_000;
        checkBudget(usage.get("reserved_micros") ?? 0, minimum, Math.floor(settings.daily_budget_usd * 1_000_000));
      }
      for (const take of takes) {
        if (take.data.status === "generating" && take.ref.id !== resume?.ref.id) {
          tx.update(take.ref, { status: "failed", failure_reasons: ["EXPIRED_JOB"] });
        }
      }
      const takeRef = resume?.ref ?? (createsTake ? ref.collection("takes").doc(token) : null);
      if (resume) tx.update(resume.ref, { status: "generating" });
      else if (takeRef) tx.create(takeRef, {
        ...blank,
        id: token, take_number: Math.max(0, ...takes.map(({ data }) => data.take_number || 0),
          ...legacy.map((take) => take.take_number || 0)) + 1,
        model: source?.data.model ?? model,
        ownerId: uid, created_at: date(), storage_path: null, cost_estimate: 0, status: "generating",
        lyric_revision: lyric, is_approved: false,
      });
      tx.set(lock, { token, expires_at: now + LEASE_MS });
      tx.update(ref, {
        status: song.status === "approved" ? "approved" : "generating",
        updated_at: date(), ...(repair ? { automatic_takes_today: automatic + 1, last_take_date: day } : {}),
      });
      return { spec, takeRef, action, source: source?.data, sourcePath, resume: resume?.data, song, settings, model };
    });
  })().catch((error: unknown) => {
    if (!(error instanceof HttpError) || error.status >= 500) logGenerationFailure(id, checkTakeId, "claim", error);
    throw error;
  });
  if (claimed.complete) return { status: claimed.complete };

  const { spec, takeRef, action, source, sourcePath, resume, song, settings, model } = claimed;
  const gemini = new Gemini(db, (status) => note(String(status), "Retry with backoff", "Retried"), (micros) => { cost += micros / 1_000_000; });
  const folder = "songs/takes/" + id + "/" + token;
  let storage = resume?.storage_path ?? null;
  let rawPath = resume?.raw_storage_path ?? null;
  let metrics: typeof blank & { transcribed_text?: string; repeated_words?: string[] } = { ...blank };
  let stage: GenerationStage = "lyria";
  let vocalPending = Boolean(resume?.vocal_check_pending);
  let failure: { cause: unknown; detail: ReturnType<typeof logGenerationFailure> } | null = null;
  let suggested: { title: string; lines: string[]; reason: string; created_at: string } | null = null;

  async function checkVocals(wav: Buffer, duration: number) {
    stage = "transcribe";
    vocalPending = true;
    const analysis = await gemini.transcribe(wav, duration);
    const report = compareTranscriptInOrder(spec.lines, analysis.transcript);
    metrics = { ...metrics, ...report, voice_start: analysis.voice_start, voice_end: analysis.voice_end,
      repeated_words: repeatedExtras(report.extra_words, spec.lines) };
    vocalPending = false;
  }

  try {
    if (checkTakeId && resume) {
      stage = "wav_download";
      metrics = { ...blank, duration_seconds: resume.duration_seconds, lufs: resume.lufs, true_peak_db: resume.true_peak_db };
      const wav = await downloadAudio(bucket, resume.storage_path!);
      if (!resume.duration_seconds) throw new Error("The mastered WAV has no recorded duration.");
      await checkVocals(wav, resume.duration_seconds);
    } else if (action?.type === "REQUEST_LYRIC_FIX") {
      stage = "lyric_repair";
      const draft = await gemini.draft(spec.admin_feeling, JSON.stringify({
        title: spec.title, lines: spec.lines, correction: action.reason,
      }), settings, []);
      assertLyrics(draft, settings);
      suggested = { title: draft.title, lines: draft.lines, reason: action.reason, created_at: date() };
      note(action.reason, "Rewrote the lyric", "Draft awaiting approval");
    } else {
      let input: Buffer;
      if (action?.type === "REMASTER") {
        stage = action.source === "raw" ? "raw_download" : "wav_download";
        input = await downloadAudio(bucket, sourcePath!);
      } else {
        const tempo = action?.type === "NEW_TAKE" ? action.tempo : spec.tempo_bpm;
        const directive = action?.type === "NEW_TAKE" ? action.directive :
          "Start singing within one second and finish by second 27. Sing each line exactly once.";
        input = await gemini.music(model, [
          "Moroccan Darija acoustic song. Length about " + settings.target_length + " seconds.",
          directive, "Theme: " + spec.theme, "Mood: " + spec.mood,
          "Tempo: " + tempo, "Instruments: " + spec.instruments, "Voice: " + spec.vocal_tone,
          "Use clear, dry solo vocals with soft accompaniment. Exact lyrics:", ...spec.lines,
        ].join("\n"));
        stage = "raw_upload";
        const rawObject = folder + "-source.mp3";
        await bucket.file(rawObject).save(input, { resumable: false, contentType: "audio/mpeg", preconditionOpts: { ifGenerationMatch: 0 } });
        rawPath = rawObject;
        await takeRef?.update({ raw_storage_path: rawPath });
      }

      stage = "master_pass1";
      let master = await masterWav(input, settings.target_length, action?.type === "REMASTER");
      if (action?.type !== "REMASTER" && (master.lufs < -15 || master.lufs > -13 || master.true_peak_db > -1)) {
        master = await masterWav(input, settings.target_length, true);
        note("Loudness or peak", "Re-mastered original audio", "Measured the new WAV");
      }
      metrics = { ...metrics, duration_seconds: master.duration_seconds, lufs: master.lufs, true_peak_db: master.true_peak_db };
      stage = "wav_upload";
      const main = folder + ".wav";
      await bucket.file(main).save(master.wav, { resumable: false, contentType: "audio/wav", preconditionOpts: { ifGenerationMatch: 0 } });
      storage = main;
      if (action?.type !== "REMASTER" || action.source === "raw") {
        vocalPending = true;
      } else if (action?.type === "REMASTER" && source) {
        metrics = { ...metrics, words_heard_pct: source.words_heard_pct,
          voice_start: source.voice_start, voice_end: source.voice_end,
          missing_words: source.missing_words, extra_words: source.extra_words,
          repeated_words: source.repeated_words ?? [], transcribed_text: source.transcribed_text ?? "" };
      }
      // Persist measured values with the WAV before any paid vocal analysis.
      await takeRef?.update({ ...metrics, storage_path: storage, vocal_check_pending: vocalPending });
      if (action?.type !== "REMASTER") await checkVocals(master.wav, master.duration_seconds);
    }
  } catch (error) {
    failure = { cause: error, detail: logGenerationFailure(id, takeRef?.id ?? null, stage, error) };
  }

  const accessFailed = firebaseDataUnavailable(failure?.cause);
  const failureMessage = failure?.cause instanceof HttpError ? failure.cause.message : accessFailed ? DATA_CONFIGURATION : null;
  const failures = failure ? ["PROCESSING_ERROR", failure.detail.stage] :
    suggested ? [] : vocalPending ? ["VOCAL_CHECK_PENDING"] : audioFailures(metrics);
  const success = !failure && !failures.length && Boolean(storage);
  const status = suggested ? "draft" : vocalPending && storage ? "needs_person" : success ? "ready" : "failed";
  let failureDetail = failure?.detail ?? null;
  if (!failure && !suggested && !vocalPending && failures.length) {
    const failedStage = failures.every((code) => ["LENGTH_INVALID", "LOUDNESS_FAILURE", "PEAK_FAILURE"].includes(code))
      ? "master_measure" : "transcribe";
    failureDetail = logGenerationFailure(id, takeRef?.id ?? null, failedStage,
      Object.assign(new Error(failures.join(", ")), { name: "QualityCheckError", code: "QUALITY_CHECK_FAILED" }));
  }
  if (action || failures.length || checkTakeId) {
    note(action?.reason ?? failures.join(", "), action?.type ?? (checkTakeId ? "Checked vocals" : "Generated a take"),
      failureMessage ?? failureDetail?.message ?? status);
  }

  await db.runTransaction(async (tx) => {
    const [lease, current, take, revision] = await Promise.all([
      tx.get(lock), tx.get(ref), takeRef ? tx.get(takeRef) : null, tx.get(db.doc("studio_meta/catalog")),
    ]);
    if (!ownsLease(lease.data(), token)) throw new HttpError(409, "The song generation lease expired.");
    const updatedAt = date();
    const takeData = { ...take?.data(), ...metrics, storage_path: storage, raw_storage_path: rawPath,
      status: success ? "ready" : "failed", failure_reasons: failures, failure_detail: failureDetail,
      vocal_check_pending: vocalPending, passed_all_checks: success, cost_estimate: (take?.get("cost_estimate") ?? 0) + cost };
    if (takeRef) tx.update(takeRef, takeData);
    const wasApproved = song.status === "approved";
    const promote = storage && !wasApproved &&
      (success || !current.get("storage_path") || current.get("best_take_id") === takeRef?.id);
    const patch = {
      ...(promote ? takeProjection(takeData) : {}),
      ...(suggested ? { title: suggested.title, lines: suggested.lines, proposed_lyric: suggested } : {}),
      status: wasApproved ? "approved" : status,
      error_message: failureMessage ?? (failure ? "Audio processing failed." : null),
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
  }).catch((error: unknown) => {
    logGenerationFailure(id, takeRef?.id ?? null, "finalize", error);
    throw error;
  });

  if (failure?.cause instanceof HttpError || accessFailed) throw failure?.cause;
  if (failure) throw new HttpError(502, "Audio processing failed at " + failure.detail.stage + ". Open the take for details.");
  return { status: song.status === "approved" ? "approved" : status, take_id: takeRef?.id ?? null };
}

export async function generationStatus(db: Firestore, id: string) {
  const [song, lock] = await db.getAll(db.doc("songs/" + id), db.doc(leasePath(id)));
  if (!song.exists) throw new HttpError(404, "Song not found.");
  return { generating: (lock.get("expires_at") ?? 0) > Date.now(), status: song.get("status") };
}
