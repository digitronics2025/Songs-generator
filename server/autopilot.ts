import { randomUUID } from "node:crypto";
import type { DocumentData, Firestore } from "firebase-admin/firestore";
import type { AutopilotStatus, AutopilotSummary } from "../src/lib/autopilot.ts";
import type { StudioSettings } from "../src/data/songs.ts";
import { casablancaClock, nextAutopilotRun } from "./autopilotSchedule.ts";
import { sendAutopilotReport } from "./autopilotReport.ts";
import { autopilotFailure, autopilotSongs, draftForAutopilot, pendingReplacements, processAutopilotSong,
  type AutopilotSong } from "./autopilotWork.ts";
import type { FirebaseServices } from "./config.ts";
import { AutopilotStopped, BudgetLimitError, type AutopilotBudget } from "./limits.ts";
import { readSettings, settingsFromDocument } from "./settings.ts";

const runsPath = "studio_autopilot_runs";
const lockPath = "studio_autopilot_state/lock";
const leaseMs = 20 * 60_000;
const workMs = 8 * 60_000;

function runSummary(data: DocumentData, now: number): AutopilotSummary {
  return {
    day: data.day, started_at: data.started_at, finished_at: data.finished_at,
    status: data.status === "running" && data.expires_at <= now ? "interrupted" : data.status,
    drafted: data.drafted, generated: data.generated, approved: data.approved, archived: data.archived,
    failed: data.failed, failures: data.failures, approved_by_feeling: data.approved_by_feeling,
    reserved_micros: data.reserved_micros, budget_micros: data.budget_micros,
    stop_reason: data.stop_reason, report_status: data.report_status,
  };
}

export async function getAutopilotStatus(db: Firestore, now = Date.now()): Promise<AutopilotStatus> {
  const [settings, latest] = await Promise.all([
    readSettings(db), db.collection(runsPath).orderBy("day", "desc").limit(1).get(),
  ]);
  const data = latest.docs[0]?.data();
  return { last_run: data ? runSummary(data, now) : null, next_run_at: nextAutopilotRun(settings.autopilot, data?.day, now) };
}

export async function claimAutopilotRun(db: Firestore, scheduled: boolean, now = Date.now()) {
  const { day, time } = casablancaClock(now);
  const run = db.doc(runsPath + "/" + day);
  const lock = db.doc(lockPath);
  const token = randomUUID();
  return db.runTransaction(async (tx) => {
    const [existing, active, settingsDoc] = await tx.getAll(run, lock, db.doc("settings/app_settings"));
    const settings = settingsFromDocument(settingsDoc.data());
    const config = settings.autopilot;
    if (!config.enabled) return { skipped: "disabled" } as const;
    if (scheduled && time < config.run_time) return { skipped: "not_due" } as const;
    if (existing.exists) return { skipped: "already_ran" } as const;
    if ((active.get("expires_at") ?? 0) > now) return { skipped: "running" } as const;
    const expires_at = now + leaseMs;
    const summary: AutopilotSummary = {
      day, started_at: new Date(now).toISOString(), finished_at: null, status: "running",
      drafted: 0, generated: 0, approved: 0, archived: 0, failed: 0, failures: {}, approved_by_feeling: [],
      reserved_micros: 0, budget_micros: Math.floor(config.daily_budget_usd * 1_000_000),
      stop_reason: null, report_status: null,
    };
    tx.create(run, { ...summary, expires_at, token, max_new_songs: config.max_new_songs });
    tx.set(lock, { token, expires_at });
    const budget: AutopilotBudget = { path: run.path, token, work_until: now + workMs, max_takes: config.max_takes_per_song };
    return { settings, summary, budget };
  });
}

export function approvedCounts(feelings: string[], songs: AutopilotSong[]) {
  const counts = new Map(feelings.map((feeling) => [feeling, 0]));
  for (const song of songs) {
    if (song.status === "approved") counts.set(song.feeling, (counts.get(song.feeling) ?? 0) + 1);
  }
  return counts;
}

export function leastApprovedFeeling(feelings: string[], approved: Map<string, number>, pipeline: Map<string, number>) {
  return [...feelings].sort((a, b) => (approved.get(a) ?? 0) - (approved.get(b) ?? 0) ||
    (pipeline.get(a) ?? 0) - (pipeline.get(b) ?? 0) || a.localeCompare(b))[0];
}

const work = {
  songs: autopilotSongs,
  replacements: pendingReplacements,
  draft: draftForAutopilot,
  process: processAutopilotSong,
  report: sendAutopilotReport,
};

function fail(summary: AutopilotSummary, reason: string) {
  summary.failed++;
  summary.failures[reason] = (summary.failures[reason] ?? 0) + 1;
}

async function runWork(
  services: FirebaseServices, uid: string, settings: StudioSettings, budget: AutopilotBudget,
  summary: AutopilotSummary, actions: typeof work,
) {
  const { db } = services;
  const cap = settings.autopilot.max_new_songs;
  const before = await actions.songs(db);
  const approved = approvedCounts(settings.feelings, before);
  const pipeline = new Map<string, number>();
  for (const song of before) {
    if (song.status === "lyric_approved") pipeline.set(song.feeling, (pipeline.get(song.feeling) ?? 0) + 1);
  }
  const replacements = await actions.replacements(db, cap);
  const attempt = async (action: () => Promise<void>) => {
    if (Date.now() >= budget.work_until) throw new AutopilotStopped("time_limit");
    try { await action(); }
    catch (error) {
      if (error instanceof BudgetLimitError || error instanceof AutopilotStopped) throw error;
      fail(summary, autopilotFailure(error));
    }
  };
  const draft = async (feeling: string, replacementFor?: string) => {
    await actions.draft(db, settings, uid, feeling, budget, replacementFor);
    summary.drafted++;
    pipeline.set(feeling, (pipeline.get(feeling) ?? 0) + 1);
  };
  const ensure = async (song: AutopilotSong) => {
    const result = await actions.process(services, song, uid, budget, () => { summary.generated++; });
    if (result.approved) summary.approved++;
    if (result.failure) fail(summary, result.failure);
    if (result.archived) {
      summary.archived++;
      if (summary.drafted < cap) await draft(song.feeling, song.id);
    }
  };

  for (let i = 0; i < cap; i++) {
    const replacement = replacements[i];
    const feeling = replacement?.feeling ?? leastApprovedFeeling(settings.feelings, approved, pipeline);
    await attempt(() => draft(feeling, replacement?.id));
  }
  const queued = await actions.songs(db);
  for (const song of queued.filter((item) => item.status === "lyric_approved")) await attempt(() => ensure(song));
  for (const song of queued.filter((item) => item.status !== "approved" && item.status !== "lyric_approved")) await attempt(() => ensure(song));
}

export async function runAutopilot(
  services: FirebaseServices, principal: { owner: string | null }, actions: typeof work = work,
) {
  const { db } = services;
  const claim = await claimAutopilotRun(db, principal.owner === null);
  if (claim.skipped) return { skipped: claim.skipped };
  const { settings, summary, budget } = claim;
  const uid = principal.owner ?? (settings.ownerId || "studio-autopilot");
  summary.status = "completed";
  try {
    await runWork(services, uid, settings, budget, summary, actions);
  } catch (error) {
    if (error instanceof BudgetLimitError) summary.stop_reason = error.scope + "_budget";
    else if (error instanceof AutopilotStopped) summary.stop_reason = error.reason;
    else {
      summary.status = "failed";
      fail(summary, autopilotFailure(error));
    }
  }
  try {
    summary.approved_by_feeling = [...approvedCounts(settings.feelings, await actions.songs(db))]
      .map(([feeling, count]) => ({ feeling, count }));
  } catch (error) {
    summary.status = "failed";
    fail(summary, autopilotFailure(error));
  }

  const run = db.doc(budget.path);
  const lock = db.doc(lockPath);
  const finalized = await db.runTransaction(async (tx) => {
    const [data, active, config] = await tx.getAll(run, lock, db.doc("settings/app_settings"));
    if (data.get("token") !== budget.token || data.get("status") !== "running" || active.get("token") !== budget.token) return null;
    const final: AutopilotSummary = { ...summary, drafted: data.get("drafted"), reserved_micros: data.get("reserved_micros"),
      finished_at: new Date().toISOString() };
    tx.update(run, { ...final });
    return { final, report: Boolean(config.get("autopilot.daily_report")) };
  });
  if (!finalized) return { skipped: "run_expired" };
  const { final } = finalized;
  final.report_status = finalized.report ? await actions.report(final).catch(() => "failed" as const) : "skipped";
  await db.runTransaction(async (tx) => {
    const active = await tx.get(lock);
    tx.update(run, { report_status: final.report_status });
    if (active.get("token") === budget.token) tx.set(lock, { token: budget.token, expires_at: 0 });
  });
  return { run: final };
}
