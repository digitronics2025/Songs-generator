import type { SongStatus } from "../data/songs";

export const VISIBLE_STATUSES = [
  "approved", "ready", "lyric_approved", "draft", "generating", "failed", "needs_person", "archived",
] as const satisfies readonly SongStatus[];
export type StatusFilter = "all" | "other" | SongStatus;
export function filterStatus(song: { status: string; archived: boolean }): SongStatus | "other" {
  if (song.archived || song.status === "archived") return "archived";
  return VISIBLE_STATUSES.find((status) => status === song.status) ?? "other";
}

export function countStatuses(songs: { status: string; archived: boolean }[]) {
  const counts = { all: 0, approved: 0, ready: 0, lyric_approved: 0, draft: 0,
    generating: 0, failed: 0, needs_person: 0, archived: 0, other: 0 };
  for (const song of songs) {
    const status = filterStatus(song);
    counts[status]++;
    if (status !== "archived") counts.all++;
  }
  return counts;
}
