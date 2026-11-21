import type { AutopilotSummary } from "../src/lib/autopilot.ts";
import { reportCard } from "./report-card.ts";

export async function sendAutopilotReport(run: AutopilotSummary) {
  const endpoint = process.env.AUTOPILOT_REPORT_URL?.trim();
  const token = process.env.AUTOPILOT_REPORT_TOKEN?.trim();
  const recipientEmail = process.env.AUTOPILOT_REPORT_RECIPIENT?.trim();
  if (!endpoint || !token || !recipientEmail || process.env.STUDIO_EMULATOR === "1") return "skipped" as const;

  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "failed" as const;
    const usd = (micros: number) => "$" + (micros / 1_000_000).toFixed(3);
    const card = reportCard()
      .why(run.day, "Studio")
      .lead("Autopilot finished with *" + run.approved + "* approved and *" + run.failed + "* failed.")
      .tiles([
        { label: "Drafted", value: String(run.drafted) }, { label: "Generated", value: String(run.generated) },
        { label: "Approved", value: String(run.approved) }, { label: "Failed", value: String(run.failed) },
      ])
      .rows([
        { label: "Budget reserved", value: usd(run.reserved_micros) + " / " + usd(run.budget_micros) },
        { label: "Archived", value: String(run.archived) },
      ])
      .details("Approved songs per feeling", run.approved_by_feeling.map(({ feeling, count }) => ({ title: feeling, value: String(count) })));
    const failures = Object.entries(run.failures).map(([reason, count]) => ({ title: reason, value: String(count) }));
    if (failures.length) card.details("Failure reasons", failures);
    if (run.stop_reason) card.note("Run stopped: " + run.stop_reason);
    const { body, blocks } = card.build();
    const payload = { sourceApp: "darija_song_studio", recipientEmail, title: "Darija Song Studio daily report",
      body, dedupeKey: "studio-autopilot-" + run.day };
    const send = (includeBlocks: boolean) => fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(includeBlocks ? { ...payload, blocks } : payload),
    });
    const response = await send(true);
    if (response.status === 400) {
      await response.body?.cancel();
      const fallback = await send(false);
      await fallback.body?.cancel();
      return fallback.ok ? "sent" as const : "failed" as const;
    }
    await response.body?.cancel();
    return response.ok ? "sent" as const : "failed" as const;
  } catch {
    return "failed" as const;
  }
}
