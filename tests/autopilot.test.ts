import { once } from "node:events";
import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTOPILOT, type AutopilotSummary } from "../src/lib/autopilot.ts";
import * as autopilot from "../server/autopilot.ts";
import { createAutopilotAuthenticator } from "../server/autopilotAuth.ts";
import { autopilotTakeQualifies } from "../server/autopilotQuality.ts";
import { sendAutopilotReport } from "../server/autopilotReport.ts";
import { autopilotRouter } from "../server/autopilotRoutes.ts";
import { casablancaClock, nextAutopilotRun } from "../server/autopilotSchedule.ts";
import { archiveAtCap } from "../server/autopilotWork.ts";
import type { FirebaseServices } from "../server/config.ts";
import { HttpError } from "../server/errors.ts";
import { checkAutopilotAllowance, checkGenerationLimits } from "../server/limits.ts";
import type { DocumentSnapshot } from "firebase-admin/firestore";

const goodTake = {
  duration_seconds: 28, lufs: -15, true_peak_db: -1, words_heard_pct: 90,
  voice_start: 1, voice_end: 27, extra_words: [], missing_words: [],
};

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Autopilot quality and caps", () => {
  it("requires all measured thresholds, including the boundary values", () => {
    expect(autopilotTakeQualifies(goodTake)).toBe(true);
    expect(autopilotTakeQualifies({ ...goodTake, duration_seconds: 45, lufs: -13 })).toBe(true);
    for (const patch of [{ words_heard_pct: 89.9 }, { lufs: -15.01 }, { lufs: -12.99 }, { true_peak_db: -0.99 },
      { voice_start: 1.01 }, { voice_start: null }, { voice_end: 27.01 }, { voice_end: 0.5 }, { voice_end: null },
      { duration_seconds: 45.01 }, { duration_seconds: 27.99 }, { extra_words: ["extra"] }, { repeated_words: ["repeat"] },
      { lufs: Number.NaN }, { true_peak_db: -Infinity }, { extra_words: undefined }]) {
      expect(autopilotTakeQualifies({ ...goodTake, ...patch }), JSON.stringify(patch)).toBe(false);
    }
  });

  it("archives only after the configured cap of failed takes, preserving pending and approved takes", () => {
    const failed = Array.from({ length: 4 }, () => ({ status: "failed" }));
    expect(archiveAtCap(failed.slice(0, 3), 4)).toBe(false);
    expect(archiveAtCap(failed, 4)).toBe(true);
    expect(archiveAtCap([...failed.slice(1), { status: "failed", vocal_check_pending: true }], 4)).toBe(false);
    expect(archiveAtCap([...failed.slice(1), { status: "failed", is_approved: true }], 4)).toBe(false);
    expect(archiveAtCap([...failed.slice(1), { status: "ready" }], 4)).toBe(false);
    expect(() => checkGenerationLimits(undefined, 2, 0, 0, 2)).toThrow("take limit");
    expect(() => checkGenerationLimits(undefined, 1, 0, 0, 2)).not.toThrow();
  });
});

it("uses Casablanca wall time and does not schedule another run for a recorded day", () => {
  const now = Date.parse("2026-05-15T01:59:00Z");
  const settings = { ...DEFAULT_AUTOPILOT, enabled: true };
  expect(casablancaClock(now)).toEqual({ day: "2026-05-15", time: "02:59" });
  expect(nextAutopilotRun(settings, undefined, now)).toBe("2026-05-15T02:00:00.000Z");
  expect(nextAutopilotRun(settings, "2026-05-15", now)).toBe("2026-05-16T02:00:00.000Z");
  expect(nextAutopilotRun(DEFAULT_AUTOPILOT, undefined, now)).toBeNull();
  expect(autopilot.leastApprovedFeeling(["a", "b", "c"], new Map([["a", 1], ["b", 1], ["c", 3]]),
    new Map([["a", 2], ["b", 1]]))).toBe("b");
});

it("rechecks current settings, deadline and run identity before reserving a call", () => {
  const budget = { path: "studio_autopilot_runs/test", token: "active", work_until: 100, max_takes: 4 };
  const snap = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] }) as DocumentSnapshot;
  const run = snap({ token: "active", status: "running", expires_at: 200, reserved_micros: 60_000, budget_micros: 200_000 });
  const settings = (enabled: boolean, daily_budget_usd: number) => snap({ quality_checks: true, autopilot: { ...DEFAULT_AUTOPILOT, enabled, daily_budget_usd } });
  expect(() => checkAutopilotAllowance(run, settings(true, 0.1), budget, 40_000, 50)).not.toThrow();
  expect(() => checkAutopilotAllowance(run, settings(true, 0.1), budget, 40_001, 50)).toThrow("daily Gemini budget");
  expect(() => checkAutopilotAllowance(run, settings(false, 0.1), budget, 0, 50)).toThrow("no longer active");
  expect(() => checkAutopilotAllowance(run, settings(true, 0.1), budget, 0, 100)).toThrow("no longer active");
  expect(() => checkAutopilotAllowance(run, settings(true, 0.1), { ...budget, token: "stale" }, 0, 50)).toThrow("no longer active");
});

describe("Autopilot endpoint authentication", () => {
  it("accepts the owner or a verified Scheduler service account for the exact audience", async () => {
    vi.stubEnv("AUTOPILOT_INVOKER_SA", "scheduler@example-project.iam.gserviceaccount.com");
    vi.stubEnv("AUTOPILOT_AUDIENCE", "https://studio.example.test/api/autopilot/run");
    const owner = vi.fn(async (header?: string) => {
      if (header === "Bearer local-owner") return "owner-uid";
      if (header === "Bearer other-owner") throw new HttpError(403, "Forbidden");
      throw new HttpError(401, "Authentication required.");
    });
    const verify = vi.fn(async ({ idToken, audience }: { idToken: string; audience?: string | string[] }) => {
      expect(audience).toBe("https://studio.example.test/api/autopilot/run");
      if (idToken === "audience-mismatch") throw new Error("Wrong audience");
      return { getPayload: () => ({
        email: idToken === "unauthorized-service" ? "not-scheduler@example-project.iam.gserviceaccount.com" :
          "scheduler@example-project.iam.gserviceaccount.com",
        email_verified: idToken !== "unverified",
      }) };
    });
    const run = vi.spyOn(autopilot, "runAutopilot").mockResolvedValue({ skipped: "disabled" });
    const db = { doc: vi.fn(), runTransaction: vi.fn(async (fn) => fn({ get: async () => ({ get: () => [] }), set: vi.fn() })) };
    const services = { db } as unknown as FirebaseServices;
    const app = express();
    app.use("/api/autopilot", autopilotRouter(services, owner, createAutopilotAuthenticator(owner, verify)));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      void _next;
      res.sendStatus(error.status ?? 400);
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server is unavailable.");
    const url = "http://127.0.0.1:" + address.port + "/api/autopilot";
    const request = (token?: string, suffix = "/run", method = "POST") => fetch(url + suffix, {
      method, headers: token ? { Authorization: "Bearer " + token } : {},
    });
    expect((await request()).status).toBe(401);
    expect((await request("other-owner")).status).toBe(403);
    expect((await request("unauthorized-service")).status).toBe(403);
    expect((await request("unverified")).status).toBe(403);
    expect((await request("audience-mismatch")).status).toBe(401);
    expect((await request("scheduler", "", "GET")).status).toBe(401);
    expect((await request("scheduler", "/run?override=true")).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
    expect((await request("local-owner")).status).toBe(200);
    expect(run).toHaveBeenNthCalledWith(1, services, { owner: "owner-uid" });
    expect((await request("scheduler")).status).toBe(200);
    expect(run).toHaveBeenNthCalledWith(2, services, { owner: null });
    expect(verify).toHaveBeenCalledWith({ idToken: "scheduler", audience: "https://studio.example.test/api/autopilot/run" });
  });
});

const summary: AutopilotSummary = {
  day: "2026-05-15", started_at: "2026-05-15T02:00:00Z", finished_at: "2026-05-15T02:03:00Z", status: "completed",
  drafted: 3, generated: 2, approved: 1, archived: 1, failed: 2, failures: { VOICE_START: 2 },
  reserved_micros: 320_000, budget_micros: 500_000, stop_reason: "autopilot_budget",
  approved_by_feeling: [{ feeling: "mothers_care", count: 3 }], report_status: null,
};

it("sends a report card only with configuration and retries a card rejection with the same dedupe key", async () => {
  vi.stubEnv("STUDIO_EMULATOR", "0");
  vi.stubEnv("AUTOPILOT_REPORT_URL", undefined);
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 400 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", send);
  expect(await sendAutopilotReport(summary)).toBe("skipped");
  expect(send).not.toHaveBeenCalled();
  vi.stubEnv("AUTOPILOT_REPORT_URL", "https://notify.example.test/api/v1/internal/notifications/ingest");
  vi.stubEnv("AUTOPILOT_REPORT_TOKEN", "public-test-fixture");
  vi.stubEnv("AUTOPILOT_REPORT_RECIPIENT", "owner@example.test");
  expect(await sendAutopilotReport(summary)).toBe("sent");
  const [first, fallback] = send.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
  expect(first).toMatchObject({ blocks: expect.any(Array), dedupeKey: "studio-autopilot-2026-05-15" });
  expect(first.body).toContain("VOICE_START");
  expect(first.body).toContain("$0.320 / $0.500");
  expect(first.body).toContain("mothers_care");
  expect(fallback).not.toHaveProperty("blocks");
  expect(fallback.dedupeKey).toBe(first.dedupeKey);
});
