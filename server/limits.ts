import { createHash } from "node:crypto";
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { HttpError } from "./errors.ts";
import { autopilotSettings } from "./schemas.ts";

export const MAX_TAKES = 4;
export const MAX_AUTO_TAKES = 2;
export const LEASE_MS = 9 * 60_000;
export const dayKey = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function checkGenerationLimits(
  lease: { expires_at?: number } | undefined, count: number, automaticCount: number, now: number, maxTakes = MAX_TAKES,
) {
  if ((lease?.expires_at ?? 0) > now) throw new HttpError(409, "This song is already generating.");
  if (count >= maxTakes) throw new HttpError(409, "This song has reached its take limit.");
  if (automaticCount >= MAX_AUTO_TAKES) throw new HttpError(409, "Daily automatic take limit reached.");
}

export class BudgetLimitError extends HttpError {
  constructor(readonly scope: "studio" | "autopilot" = "studio") {
    super(429, scope === "autopilot" ? "The Autopilot daily Gemini budget has been reached." : "The studio daily Gemini budget has been reached.");
  }
}

export class AutopilotStopped extends HttpError {
  constructor(readonly reason: "time_limit" | "disabled" | "run_expired") {
    super(409, "Autopilot stopped because the run is no longer active.");
  }
}

export interface AutopilotBudget {
  path: string;
  token: string;
  work_until: number;
  max_takes: number;
}

export function checkBudget(spent: number, cost: number, limit: number, scope: "studio" | "autopilot" = "studio") {
  if (!Number.isSafeInteger(spent) || spent < 0 || !Number.isSafeInteger(cost) || cost < 0 ||
      !Number.isSafeInteger(limit) || limit < 0 || spent + cost > limit) {
    throw new BudgetLimitError(scope);
  }
}

export function defaultBudget() {
  const value = Number(process.env.STUDIO_DAILY_BUDGET_USD ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 1000) : 0;
}

export function checkAutopilotAllowance(run: DocumentSnapshot, settings: DocumentSnapshot,
  budget: AutopilotBudget, cost: number, now = Date.now()) {
  if (run.get("token") !== budget.token || run.get("status") !== "running" || run.get("expires_at") <= now) {
    throw new AutopilotStopped("run_expired");
  }
  if (now >= budget.work_until) throw new AutopilotStopped("time_limit");
  const current = autopilotSettings.safeParse(settings.get("autopilot"));
  if (!current.success || !current.data.enabled) throw new AutopilotStopped("disabled");
  const cap = Math.min(run.get("budget_micros"), Math.floor(current.data.daily_budget_usd * 1_000_000));
  checkBudget(run.get("reserved_micros"), cost, cap, "autopilot");
}

// Integer millionths of a USD. Reserve before each dispatch, including retries.
export async function reserveBudget(db: Firestore, cost: number, autopilot?: AutopilotBudget) {
  const ref = db.doc("studio_usage/" + dayKey());
  await db.runTransaction(async (tx) => {
    const runRef = autopilot ? db.doc(autopilot.path) : undefined;
    const [usage, settings, run] = await tx.getAll(ref, db.doc("settings/app_settings"), ...(runRef ? [runRef] : []));
    const configured = settings.get("daily_budget_usd");
    const budget = typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? Math.min(configured, 1000) : defaultBudget();
    const spent = usage.get("reserved_micros") ?? 0;
    checkBudget(spent, cost, Math.floor(budget * 1_000_000));
    if (autopilot && runRef) {
      checkAutopilotAllowance(run, settings, autopilot, cost);
      tx.update(runRef, { reserved_micros: run.get("reserved_micros") + cost });
    }
    tx.set(ref, { reserved_micros: spent + cost }, { merge: true });
  });
}

export async function rateLimit(db: Firestore, namespace: string, principal: string, limit: number) {
  const now = Date.now();
  const ref = db.doc("studio_limits/" + hash(namespace + ":" + principal));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const earlier: number[] = (snap.get("requests") ?? []).filter((time: number) => time > now - 60_000);
    if (earlier.length >= limit) throw new HttpError(429, "Too many requests. Try again in a minute.");
    tx.set(ref, { requests: [...earlier, now] });
  });
}
