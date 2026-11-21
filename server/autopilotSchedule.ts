import { AUTOPILOT_TICK_MS, AUTOPILOT_ZONE, type AutopilotSettings } from "../src/lib/autopilot.ts";

const casablanca = new Intl.DateTimeFormat("sv-SE", {
  timeZone: AUTOPILOT_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function casablancaClock(now: number) {
  const [day, time] = casablanca.format(now).split(" ");
  return { day, time };
}

export function nextAutopilotRun(settings: AutopilotSettings, usedDay: string | undefined, now: number) {
  if (!settings.enabled) return null;
  for (let tick = (Math.floor(now / AUTOPILOT_TICK_MS) + 1) * AUTOPILOT_TICK_MS;
    tick <= now + 3 * 24 * 60 * 60_000; tick += AUTOPILOT_TICK_MS) {
    const { day, time } = casablancaClock(tick);
    if (day !== usedDay && time >= settings.run_time) return new Date(tick).toISOString();
  }
  return null;
}
