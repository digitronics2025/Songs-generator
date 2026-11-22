import type { DocumentData, Firestore } from "firebase-admin/firestore";
import { DEFAULT_STUDIO_SETTINGS, INITIAL_SONGS, formatSongFilename, type SongTake } from "../src/data/songs.ts";
import { DEFAULT_ADMIN_FEELING_BY_KEY, validateLyrics } from "../src/lib/lyricQuality.ts";
import { FieldValue } from "firebase-admin/firestore";
import { storagePathFromUrl } from "./storage.ts";
import { hash } from "./limits.ts";

const version = "catalog_v1";

export const lyricRevision = (title: string, lines: string[]) => hash(JSON.stringify([title, lines]));

export function migrateStatus(status: unknown, hasAudio: boolean): string {
  if (status === "pending") return "draft";
  if (status === "error") return "failed";
  if (status === "ready" && !hasAudio) return "draft";
  return typeof status === "string" && status !== "" ? status : hasAudio ? "ready" : "draft";
}

export function historyRecord(
  historyId: string, songId: string, song: DocumentData, action: string, now: string,
) {
  return {
    id: historyId, song_id: songId, song_number: song.number ?? 0,
    title: song.title ?? "", lines: song.lines ?? [],
    admin_feeling: song.admin_feeling || "unset", action, timestamp: now, ownerId: song.ownerId ?? "",
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function metric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function legacyTakes(song: DocumentData, now: string, bucket?: string): SongTake[] {
  const takes: SongTake[] = [];
  const paths = new Set<string>();
  const embedded: DocumentData[] = Array.isArray(song.takes) ? song.takes.filter(
    (take): take is DocumentData => Boolean(take) && typeof take === "object",
  ) : [];
  const approvedId = text(song.approved_take_id) ?? (song.status === "approved" ? text(song.best_take_id) : null);
  for (const data of [...embedded, song]) {
    const top = data === song;
    const oldUrl = text(data.download_url);
    let storagePath = text(data.storage_path);
    if (!storagePath && oldUrl && bucket) {
      try { storagePath = storagePathFromUrl(oldUrl, bucket); } catch { /* Preserve the old reference without fetching it. */ }
    }
    const location = storagePath ?? oldUrl;
    if (!location || paths.has(location)) continue;
    paths.add(location);
    const oldId = top ? text(song.best_take_id) : text(data.id);
    const takeId = oldId && /^[\w-]{1,128}$/.test(oldId) && !takes.some((take) => take.id === oldId)
      ? oldId : "legacy_" + hash(location).slice(0, 32);
    takes.push({
      id: takeId, storage_path: storagePath, download_url: oldUrl,
      ownerId: data.ownerId ?? song.ownerId ?? "", created_at: data.created_at ?? song.generated_at ?? now,
      take_number: metric(data.take_number) ?? takes.length + 1,
      model: text(data.model ?? data.model_used) ?? "legacy",
      duration_seconds: metric(data.duration_seconds), lufs: metric(data.lufs), true_peak_db: metric(data.true_peak_db),
      words_heard_pct: metric(data.words_heard_pct), missing_words: data.missing_words ?? [],
      extra_words: data.extra_words ?? [], transcribed_text: text(data.transcribed_text),
      voice_start: metric(data.voice_start ?? data.voice_start_seconds),
      voice_end: metric(data.voice_end ?? data.voice_end_seconds),
      cost_estimate: metric(data.cost_estimate) ?? 0,
      status: data.status === "failed" ? "failed" : "ready",
      is_approved: Boolean(data.is_approved || (approvedId && approvedId === oldId) ||
        (top && song.status === "approved" && !approvedId)),
      lyric_revision: lyricRevision(song.title ?? "", song.lines ?? []),
    });
  }
  return takes;
}

export function migrationPatch(key: string, old: DocumentData, now: string, take?: SongTake) {
  const number = typeof old.number === "number" ? old.number : Number(key);
  const spec = INITIAL_SONGS.find((value) => value.number === number && (!old.feeling_key || old.feeling_key === value.feeling_key));
  const feelingKey = old.feeling_key ?? spec?.feeling_key;
  const mapped = typeof feelingKey === "string" && Object.hasOwn(DEFAULT_ADMIN_FEELING_BY_KEY, feelingKey)
    ? DEFAULT_ADMIN_FEELING_BY_KEY[feelingKey] : undefined;
  const hasAudio = Boolean(old.storage_path || take?.storage_path);
  const status = migrateStatus(old.status, hasAudio);
  const changedLyrics = Boolean(spec && lyricRevision(spec.title, spec.lines) !== lyricRevision(old.title ?? "", old.lines ?? []));
  return {
    ...(spec ? {
      theme: old.theme ?? spec.theme, mood: old.mood ?? spec.mood,
      tempo_bpm: old.tempo_bpm ?? spec.tempo_bpm, instruments: old.instruments ?? spec.instruments,
      vocal_tone: old.vocal_tone ?? spec.vocal_tone,
      file_name: old.file_name ?? formatSongFilename(spec.number, spec.feeling_key),
    } : {}),
    ...(old.id && old.id !== key ? { legacy_id: old.id } : {}),
    id: key, ...(Number.isSafeInteger(number) && number > 0 ? { number } : {}),
    ...(spec ? { title: spec.title, lines: spec.lines } : {}),
    ...(feelingKey ? { feeling_key: feelingKey } : {}),
    ...(mapped && (spec || !old.admin_feeling) ? { admin_feeling: mapped } : {}),
    status: changedLyrics && status === "approved" ? (hasAudio ? "ready" : "draft") : status,
    ...(take && !old.best_take_id ? { best_take_id: take.id } : {}),
    ...(!old.storage_path && take?.storage_path ? { storage_path: take.storage_path } : {}),
    updated_at: now, migration_version: version,
  };
}

export async function migrateCatalog(db: Firestore, uid: string, dryRun: boolean, bucket?: string) {
  const now = new Date().toISOString();
  const entries = await db.collection("songs").get();
  const occupied = new Set(entries.docs.map((snap) => snap.get("number") ?? Number(snap.id)));
  const targets = [...entries.docs.map((snap) => snap.id)];
  for (const spec of INITIAL_SONGS) {
    const key = String(spec.number);
    if (!occupied.has(spec.number) && !targets.includes(key)) targets.push(key);
  }

  const result = { scanned: targets.length, migrated: 0, skipped: 0, seeded: 0, legacy_takes: 0 };
  for (const key of targets) {
    const outcome = await db.runTransaction(async (tx) => {
      const ref = db.doc("songs/" + key);
      const [snap, takeDocs, lease] = await Promise.all([tx.get(ref), tx.get(ref.collection("takes")), tx.get(db.doc("studio_locks/" + key))]);
      const old = snap.data();
      if ((lease.get("expires_at") ?? 0) > Date.now() || old?.migration_version === version) return null;
      const spec = INITIAL_SONGS.find((value) => String(value.number) === key);
      if (!old && !spec) return null;

      const existingIds = new Set(takeDocs.docs.map((doc) => doc.id));
      const existingPaths = new Set(takeDocs.docs.map((doc) => doc.get("storage_path")).filter(Boolean));
      const legacy = old ? legacyTakes(old, now, bucket).filter((take) =>
        !existingIds.has(take.id) && !existingPaths.has(take.storage_path)
      ) : [];
      const canonical = legacy.find((take) => take.id === old?.best_take_id) ??
        legacy.find((take) => Boolean(old?.storage_path && take.storage_path === old.storage_path)) ?? legacy[0];
      const updated = old ? migrationPatch(key, old, now, canonical) : {
        ...spec!, id: key, status: "draft", ownerId: uid, created_at: now, updated_at: now,
        archived: false, best_take_id: null, migration_version: version,
        file_name: formatSongFilename(spec!.number, spec!.feeling_key),
      };
      if ((spec || ("lines" in updated)) && Array.isArray(updated.lines) &&
          !validateLyrics(updated.lines, { ...DEFAULT_STUDIO_SETTINGS, rhyme_scheme: "OFF" }).valid) {
        throw new Error("A default lyric failed migration validation.");
      }
      if (!dryRun) {
        const current = { ...old, ...updated };
        const historyId = "migration_" + hash(key).slice(0, 32);
        const oldId = historyId + "_before";
        if (old && Array.isArray(old.lines) &&
            lyricRevision(old.title ?? "", old.lines) !== lyricRevision(current.title ?? "", current.lines ?? [])) {
          tx.create(db.doc("song_history/" + oldId), historyRecord(oldId, key, old, "migrated", now));
        }
        tx.create(db.doc("song_history/" + historyId), historyRecord(historyId, key, current, "migrated", now));
        for (const take of legacy) tx.create(ref.collection("takes").doc(take.id), take);
        tx.set(ref, updated, { merge: true });
        tx.set(db.doc("studio_meta/catalog"), { version: FieldValue.increment(1) }, { merge: true });
      }
      return { seeded: !old, legacy: legacy.length };
    });
    if (!outcome) result.skipped++;
    else {
      result.migrated++;
      result.seeded += Number(outcome.seeded);
      result.legacy_takes += outcome.legacy;
    }
  }
  if (!dryRun) {
    await db.collection("studio_migrations").add({ version, at: now, ...result });
    console.info(JSON.stringify({ event: "studio_migration", version, ...result }));
  }
  return result;
}
