import { useEffect, useState } from "react";
import { AUTOPILOT_ZONE, type AutopilotSettings, type AutopilotStatus } from "../lib/autopilot";
import { studioApi } from "../lib/api";

interface Props {
  settings: AutopilotSettings;
  onChange: (settings: AutopilotSettings) => void;
}

const inputClass = "mt-1 w-full rounded-lg border border-[#D4D2CA] bg-white px-3 py-2 text-sm";
const casablanca = new Intl.DateTimeFormat(undefined, {
  timeZone: AUTOPILOT_ZONE, dateStyle: "medium", timeStyle: "short",
});
const dateLabel = (value: string) => casablanca.format(new Date(value));
const usd = (micros: number) => (micros / 1_000_000).toLocaleString("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 3,
});

export function AutopilotPanel({ settings, onChange }: Props) {
  const [status, setStatus] = useState<AutopilotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await studioApi<AutopilotStatus>("/autopilot", "GET", undefined, controller.signal);
        if (!controller.signal.aborted) { setStatus(data); setError(null); }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load Autopilot.");
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  const run = status?.last_run;
  const next = status?.next_run_at;
  return (
    <section className="rounded-xl border border-[#E5E4DF] bg-white p-6 shadow-xs">
      <h3 className="text-lg font-bold text-[#141413]">Autopilot</h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.enabled}
            onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />
          Enable daily Autopilot
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.daily_report}
            onChange={(event) => onChange({ ...settings, daily_report: event.target.checked })} />
          Send daily Messenger report
        </label>
        <label className="text-sm">
          Autopilot daily budget (USD)
          <input className={inputClass} type="number" min={0} max={1000} step={0.01} value={settings.daily_budget_usd}
            onChange={(event) => onChange({ ...settings, daily_budget_usd: Number(event.target.value) })} />
        </label>
        <label className="text-sm">
          New songs per day
          <input className={inputClass} type="number" min={0} max={12} step={1} value={settings.max_new_songs}
            onChange={(event) => onChange({ ...settings, max_new_songs: Number(event.target.value) })} />
        </label>
        <label className="text-sm">
          Takes per song
          <input className={inputClass} type="number" min={1} max={4} step={1} value={settings.max_takes_per_song}
            onChange={(event) => onChange({ ...settings, max_takes_per_song: Number(event.target.value) })} />
        </label>
        <label className="text-sm">
          Run time (Casablanca, every 5 minutes)
          <input className={inputClass} type="time" step={300} value={settings.run_time}
            onChange={(event) => onChange({ ...settings, run_time: event.target.value })} />
        </label>
      </div>
      <p className="mt-3 text-xs text-[#6E6C66]">Use Save Settings to apply changes. Cloud Scheduler must be configured to start daily runs.</p>
      {error ? <p className="mt-4 text-sm text-red-700" role="alert">{error}</p> : !status ?
        <p className="mt-4 text-sm" role="status">Loading run summary…</p> : (
          <div className="mt-4 space-y-2 border-t border-[#ECEBE6] pt-4 text-sm" aria-live="polite">
            <p>Next run {next ? dateLabel(next) : "—"}</p>
            {run ? <>
              <p>Last run {dateLabel(run.started_at)} · {run.status}</p>
              <p>{run.drafted} drafted · {run.generated} generated · {run.approved} approved · {run.failed} failed · {run.archived} archived</p>
              <p>Reserved {usd(run.reserved_micros)} of {usd(run.budget_micros)}</p>
              {run.stop_reason && <p>Stopped due to {run.stop_reason.replaceAll("_", " ")}</p>}
              {run.report_status && <p>Messenger report {run.report_status}</p>}
              {Object.keys(run.failures).length > 0 && <ul className="list-disc pl-5">
                {Object.entries(run.failures).map(([reason, count]) => <li key={reason}>{reason} ({count})</li>)}
              </ul>}
            </> : <p>No runs recorded.</p>}
          </div>
        )}
    </section>
  );
}
