import { useState } from "react";
import type { SongState, StudioSettings } from "../data/songs";
import { ApiError, songPath, studioApi } from "../lib/api";
import type { Draft } from "../../server/schemas";

export type SavedDraft = Draft & { isApproved: boolean };

export function useSongActions(songs: SongState[], refresh: () => Promise<void>, report: (message: string) => void) {
  const [generatingNumbers, setGeneratingNumbers] = useState<Set<number>>(new Set());
  async function mutate(path: string, method = "POST", body?: unknown) {
    try {
      await studioApi(path, method, body);
      await refresh();
    } catch (error) {
      report(error instanceof Error ? error.message : "Studio update failed.");
      throw error;
    }
  }
  async function generate(songNumber: number, repair = false) {
    const song = songs.find((item) => item.number === songNumber);
    if (!song) return { stopBatch: false };
    setGeneratingNumbers((previous) => new Set([...previous, songNumber]));
    try {
      const outcome = await studioApi<{ status: string }>(songPath(song.id) + (repair ? "/repair" : "/generate"), "POST");
      if (outcome.status === "failed" && !repair) {
        const repaired = await studioApi<{ status: string }>(songPath(song.id) + "/repair", "POST");
        if (repaired.status !== "failed") return { stopBatch: false };
      }
      if (outcome.status === "failed") report("Take for song #" + songNumber + " did not pass. Open its repair log for details.");
      return { stopBatch: false };
    } catch (error) {
      report(error instanceof Error ? error.message : "Song generation failed.");
      return { stopBatch: error instanceof ApiError && [401, 403, 429, 503].includes(error.status) };
    } finally {
      setGeneratingNumbers((previous) => {
        const next = new Set(previous);
        next.delete(songNumber);
        return next;
      });
      await refresh();
    }
  }
  async function create(drafts: SavedDraft[]) {
    const result = await studioApi<{ ids: string[] }>("/songs", "POST", { drafts });
    if (result.ids.length !== drafts.length) throw new Error("Could not confirm all new songs.");
    await refresh();
  }
  return {
    generatingNumbers, handleGenerateSong: generate,
    handleAddNewSong: (draft: SavedDraft) => create([draft]),
    handleAddBatchSongs: create,
    handleApproveLyric: (id: string) => mutate(songPath(id) + "/approve-lyric"),
    handleApproveTake: (id: string, take: string) => mutate(songPath(id) + "/takes/" + take, "POST", { approve: true }),
    handleChooseTake: (id: string, take: string) => mutate(songPath(id) + "/takes/" + take, "POST", { approve: false }),
    handleSaveEdit: (id: string, edits: Partial<Omit<Draft, "feeling_key">>) => mutate(songPath(id), "PATCH", edits),
    handleChangeAdminFeeling: (id: string, admin_feeling: string) => mutate(songPath(id), "PATCH", { admin_feeling }),
    handleToggleArchive: (id: string, archived: boolean) => mutate(songPath(id) + "/archive", "POST", { archived }),
    handleSaveSettings: ({ ownerId, updated_at, ...settings }: StudioSettings) => {
      void ownerId;
      void updated_at;
      return mutate("/settings", "PUT", settings);
    },
  };
}
