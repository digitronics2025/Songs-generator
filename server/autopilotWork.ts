import type { Firestore } from "firebase-admin/firestore";
import type { StudioSettings } from "../src/data/songs.ts";
import { audioFailures } from "../src/lib/songRepair.ts";
import { autopilotTakeQualifies } from "./autopilotQuality.ts";
import { createSongs, mutateSong, proposeDrafts, selectTake } from "./catalog.ts";
import type { FirebaseServices } from "./config.ts";
import { HttpError } from "./errors.ts";
import { generateTake } from "./generation.ts";
import { AutopilotStopped, BudgetLimitError, checkAutopilotAllowance, type AutopilotBudget } from "./limits.ts";
import { legacyTakes, lyricRevision } from "./migration.ts";

export interface AutopilotSong {
  id: string;
  status: string;
  feeling: string;
  created_at: string;
}

const activeStatuses = ["approved", "lyric_approved", "failed", "needs_person", "ready", "generating"];
export async function autopilotSongs(db: Firestore) {
  const results = await db.collection("songs").where("status", "in", activeStatuses).select("status", "archived", "admin_feeling", "created_at").get();
  return results.docs.filter((doc) => !doc.get("archived")).map((doc): AutopilotSong => ({
    id: doc.id, status: doc.get("status"), feeling: doc.get("admin_feeling") ?? "unset", created_at: doc.get("created_at") ?? "",
  })).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export async function pendingReplacements(db: Firestore, limit: number) {
  if (!limit) return [];
  const results = await db.collection("songs").where("autopilot_replacement_pending", "==", true).limit(limit).get();
  return results.docs.filter((doc) => doc.get("archived") && typeof doc.get("admin_feeling") === "string")
    .map((doc) => ({ id: doc.id, feeling: doc.get("admin_feeling") as string }));
}

export async function draftForAutopilot(
  db: Firestore, settings: StudioSettings, uid: string, feeling: string, budget: AutopilotBudget, replacementFor?: string,
) {
  const { drafts } = await proposeDrafts(db, settings, [feeling], 1,
    "An ordinary, specific moment in a Moroccan household.", budget);
  const [id] = await createSongs(db, settings, uid, drafts.map(({ closest_match_pct, validation, ...lyric }) => {
    void closest_match_pct;
    void validation;
    return { ...lyric, isApproved: true };
  }), budget, replacementFor);
  return id;
}

function archivalReason(cap: number) {
  return "Autopilot reached the " + cap + "-take limit with no passing recording.";
}

async function archiveFailedLyric(db: Firestore, id: string, revision: string, budget: AutopilotBudget) {
  const ref = db.doc("songs/" + id);
  let reason = "";
  const archived = await mutateSong(db, id, async (song, tx) => {
    if (song.archived || song.status === "approved" || song.approved_take_id ||
        lyricRevision(song.title, song.lines) !== revision || !["failed", "needs_person", "lyric_approved", "generating"].includes(song.status)) return null;
    const [run, settings] = await tx.getAll(db.doc(budget.path), db.doc("settings/app_settings"));
    checkAutopilotAllowance(run, settings, budget, 0);
    const takes = (await tx.get(ref.collection("takes"))).docs.map((doc) => doc.data());
    const cap = Math.min(budget.max_takes, settings.get("autopilot.max_takes_per_song"));
    if (!archiveAtCap(takes, cap)) return null;
    reason = archivalReason(cap);
    return {
      action: "archived",
      patch: { archived: true, status: "archived", pre_archive_status: song.status, archive_reason: reason, autopilot_replacement_pending: true },
    };
  });
  return archived ? reason : null;
}

export function archiveAtCap(takes: Array<{ status?: string; is_approved?: boolean; vocal_check_pending?: boolean }>, cap: number) {
  return takes.length >= cap && takes.every((take) => take.status === "failed" && !take.is_approved && !take.vocal_check_pending);
}

export function autopilotFailure(error: unknown) {
  return error instanceof HttpError ? "Request failed (" + error.status + ")" : "Studio processing failed";
}

export async function processAutopilotSong(
  services: FirebaseServices, candidate: AutopilotSong, uid: string, budget: AutopilotBudget, onMusicSaved: () => void,
) {
  const { db } = services;
  const ref = db.doc("songs/" + candidate.id);
  const [song, takes] = await Promise.all([ref.get(), ref.collection("takes").orderBy("take_number").get()]);
  const data = song.data();
  if (!data || data.archived || !activeStatuses.includes(data.status) || data.status === "approved") return {};
  if (typeof data.title !== "string" || !Array.isArray(data.lines) || !data.lines.every((line) => typeof line === "string")) return { failure: "Missing song metadata" };
  const revision = lyricRevision(data.title, data.lines);
  const matching = takes.docs.filter((take) => take.get("lyric_revision") === revision);
  const ids = { budget, onMusicSaved };
  const approveBest = async (choices: typeof matching) => {
    const best = choices.filter((take) => take.get("status") === "ready" && take.get("passed_all_checks") &&
      take.get("storage_path")?.endsWith(".wav") && autopilotTakeQualifies(take.data()))
      .sort((a, b) => b.get("words_heard_pct") - a.get("words_heard_pct") ||
        Math.abs(a.get("lufs") + 14) - Math.abs(b.get("lufs") + 14) ||
        a.id.localeCompare(b.id))[0];
    return best ? selectTake(db, candidate.id, best.id, true, budget) : false;
  };
  if (await approveBest(matching)) return { approved: true };
  if (data.status === "ready") return { failure: "No take passed every quality check" };

  const rawToRepair = matching.some((take) => ["failed", "generating"].includes(take.get("status")) && !take.get("is_approved") &&
    take.get("raw_storage_path") && !take.get("storage_path"));
  const pending = [...matching].reverse().find((take) => !take.get("is_approved") &&
    take.get("vocal_check_pending") && take.get("storage_path")?.endsWith(".wav"));
  const legacy = legacyTakes(data, data.updated_at ?? "", services.bucket.name)
    .filter((take) => !takes.docs.some((doc) => doc.id === take.id ||
      (take.storage_path && doc.get("storage_path") === take.storage_path)));
  const exhausted = takes.docs.length + legacy.length >= budget.max_takes;
  let requestFailure: string | undefined;
  let attemptResult: Awaited<ReturnType<typeof generateTake>> | undefined;
  try {
    if (rawToRepair) {
      attemptResult = await generateTake(services, candidate.id, uid, "repair", ids);
      if (attemptResult.status === "needs_person" && attemptResult.take_id) {
        attemptResult = await generateTake(services, candidate.id, uid, { checkVocals: attemptResult.take_id }, ids);
      }
    } else if (pending) {
      attemptResult = await generateTake(services, candidate.id, uid, { checkVocals: pending.id }, ids);
    } else if (!exhausted) {
      attemptResult = await generateTake(services, candidate.id, uid, data.status === "lyric_approved" ? "generate" : "repair", ids);
    }
  } catch (error) {
    if (error instanceof AutopilotStopped || error instanceof BudgetLimitError) throw error;
    requestFailure = autopilotFailure(error);
  }

  if (attemptResult?.status === "lyric_approved") return {};
  const after = await ref.collection("takes").orderBy("take_number").get();
  const current = after.docs.filter((take) => take.get("lyric_revision") === revision);
  if (await approveBest(current)) return { approved: true };
  if (archiveAtCap(after.docs.map((take) => take.data()), budget.max_takes)) {
    const reason = await archiveFailedLyric(db, candidate.id, revision, budget);
    if (reason) return { archived: true, failure: reason };
  }
  const take = current.at(-1)?.data();
  if (take?.vocal_check_pending && !requestFailure) {
    // The remaster kept the raw and WAV. The next action can analyze vocals without requesting Lyria.
    return {};
  }
  const reasons: unknown = take?.failure_reasons;
  const measured = Array.isArray(reasons) ? reasons.filter((reason): reason is string =>
    typeof reason === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(reason)) : [];
  if (measured.length) return { failure: measured.join(", ") };
  if (requestFailure) return { failure: requestFailure };
  if (take?.status === "ready" && !autopilotTakeQualifies(take)) {
    const failures = audioFailures({ ...take, extra_words: take.extra_words ?? [] } as Parameters<typeof audioFailures>[0]);
    return { failure: failures.join(", ") || "No take passed every quality check" };
  }
  return exhausted ? { failure: "Take limit reached" } : {};
}
