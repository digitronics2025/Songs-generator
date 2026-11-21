import type { FirebaseServices } from "./config.ts";
import { HttpError } from "./errors.ts";
import { hash } from "./limits.ts";
import { encodeMp3 } from "./ffmpeg.ts";

const maxAudio = 25 * 1024 * 1024;
const objectPath = /^songs\/(?:takes\/(?:[\w-]{1,128}\/)?|cache\/)?[\w.-]{1,190}\.(?:wav|mp3)$/i;
export function checkedObjectPath(value: string) {
  if (!objectPath.test(value) || value.includes("..")) throw new HttpError(400, "Invalid studio audio path.");
  return value;
}

export function storagePathFromUrl(value: string, bucket: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error();
    let path: string | undefined;
    if (url.hostname === "firebasestorage.googleapis.com") {
      const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);
      if (match?.[1] === bucket) path = decodeURIComponent(match[2]);
    } else if (url.hostname === "storage.googleapis.com") {
      const match = /^\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (match?.[1] === bucket) path = decodeURIComponent(match[2]);
    } else if (url.hostname === bucket + ".storage.googleapis.com") {
      path = decodeURIComponent(url.pathname.slice(1));
    }
    return checkedObjectPath(path ?? "");
  } catch {
    throw new HttpError(400, "Invalid studio audio URL.");
  }
}

async function storedAudio(bucket: FirebaseServices["bucket"], path: string) {
  const file = bucket.file(checkedObjectPath(path));
  const [meta] = await file.getMetadata().catch((error: { code?: number }) => {
    if (error.code === 404) throw new HttpError(404, "Studio audio was not found.");
    throw error;
  });
  const size = Number(meta.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxAudio) {
    throw new HttpError(422, "Stored audio size is out of bounds.");
  }
  const immutable = bucket.file(path, { generation: meta.generation });
  const [bytes] = await immutable.download();
  return { bytes, file: immutable };
}

export async function downloadAudio(bucket: FirebaseServices["bucket"], path: string) {
  return (await storedAudio(bucket, path)).bytes;
}

export async function signedAudio(
  bucket: FirebaseServices["bucket"], source: string, format: "wav" | "mp3", now?: number,
) {
  if (!source.toLowerCase().endsWith(".wav")) throw new HttpError(422, "The best take has no mastered WAV.");
  let artifact = await storedAudio(bucket, source);
  if (format === "mp3") {
    const path = "songs/cache/" + hash(artifact.bytes) + ".mp3";
    try { artifact = await storedAudio(bucket, path); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      const output = await encodeMp3(artifact.bytes);
      try {
        await bucket.file(path).save(output, {
          resumable: false, contentType: "audio/mpeg", preconditionOpts: { ifGenerationMatch: 0 },
        });

      } catch (writeError) {
        if ((writeError as { code?: number }).code !== 412) throw writeError;

      }
      artifact = await storedAudio(bucket, path);
    }
  }
  const [url] = await artifact.file.getSignedUrl({ version: "v4", action: "read", expires: (now ?? Date.now()) + 900_000,
    responseType: format === "wav" ? "audio/wav" : "audio/mpeg" });
  return { url, sha256: hash(artifact.bytes), content_type: format === "wav" ? "audio/wav" : "audio/mpeg", bytes: artifact.bytes.length };
}
