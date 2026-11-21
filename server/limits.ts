import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { HttpError } from "./errors.ts";

export const MAX_TAKES = 4;
export const MAX_AUTO_TAKES = 2;
export const LEASE_MS = 9 * 60_000;
export const dayKey = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function checkGenerationLimits(
  lease: { expires_at?: number } | undefined, count: number, automaticCount: number, now: number,
) {
  if ((lease?.expires_at ?? 0) > now) throw new HttpError(409, "This song is already generating.");
  if (count >= MAX_TAKES) throw new HttpError(409, "This song has reached its take limit.");
  if (automaticCount >= MAX_AUTO_TAKES) throw new HttpError(409, "Daily automatic take limit reached.");
}

export function checkBudget(spent: number, cost: number, limit: number) {
  if (!Number.isSafeInteger(spent) || spent < 0 || spent + cost > limit) {
    throw new HttpError(429, "The studio daily Gemini budget has been reached.");
  }
}

export function defaultBudget() {
  const value = Number(process.env.STUDIO_DAILY_BUDGET_USD ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 1000) : 0;
}

// Integer millionths of a USD. Reserve before each dispatch, including retries.
export async function reserveBudget(db: Firestore, cost: number) {
  const ref = db.doc("studio_usage/" + dayKey());
  await db.runTransaction(async (tx) => {
    const [usage, settings] = await tx.getAll(ref, db.doc("settings/app_settings"));
    const configured = settings.get("daily_budget_usd");
    const budget = typeof configured === "number" && Number.isFinite(configured) && configured >= 0
      ? Math.min(configured, 1000) : defaultBudget();
    const spent = usage.get("reserved_micros") ?? 0;
    checkBudget(spent, cost, Math.floor(budget * 1_000_000));
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
