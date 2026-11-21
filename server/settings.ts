import type { DocumentData, Firestore } from "firebase-admin/firestore";
import { DEFAULT_STUDIO_SETTINGS, type StudioSettings } from "../src/data/songs.ts";
import { musicModels, studioSettings } from "./schemas.ts";
import { defaultBudget } from "./limits.ts";

export async function readSettings(db: Firestore): Promise<StudioSettings> {
  return settingsFromDocument((await db.doc("settings/app_settings").get()).data());
}

export function settingsFromDocument(input: DocumentData = {}): StudioSettings {
  const defaults = { ...DEFAULT_STUDIO_SETTINGS, daily_budget_usd: defaultBudget() };
  const { updated_at, ownerId, ...base } = defaults;
  const fields = { ...base };
  for (const key of Object.keys(studioSettings.shape) as (keyof typeof fields)[]) {
    const value = studioSettings.shape[key].safeParse(input[key]);
    if (value.success && value.data !== undefined) Object.assign(fields, { [key]: value.data });
  }
  return { ...fields, ownerId: input.ownerId ?? ownerId, updated_at: input.updated_at ?? updated_at };
}

export function musicModel(value: unknown) {
  const result = musicModels.safeParse(value);
  return result.success ? result.data : "lyria-3-clip-preview";
}
