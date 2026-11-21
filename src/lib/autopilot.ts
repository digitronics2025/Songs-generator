export const AUTOPILOT_ZONE = "Africa/Casablanca";
export const AUTOPILOT_TICK_MS = 5 * 60_000;

export interface AutopilotSettings {
  enabled: boolean;
  daily_budget_usd: number;
  max_new_songs: number;
  max_takes_per_song: number;
  run_time: string;
  daily_report: boolean;
}

export const DEFAULT_AUTOPILOT: AutopilotSettings = {
  enabled: false,
  daily_budget_usd: 0,
  max_new_songs: 3,
  max_takes_per_song: 4,
  run_time: "03:00",
  daily_report: false,
};

export interface AutopilotSummary {
  day: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "interrupted" | "failed";
  drafted: number;
  generated: number;
  approved: number;
  archived: number;
  failed: number;
  failures: Record<string, number>;
  approved_by_feeling: Array<{ feeling: string; count: number }>;
  reserved_micros: number;
  budget_micros: number;
  stop_reason: string | null;
  report_status: "sent" | "failed" | "skipped" | null;
}

export interface AutopilotStatus {
  next_run_at: string | null;
  last_run: AutopilotSummary | null;
}
