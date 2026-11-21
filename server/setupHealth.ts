import type { RequestHandler } from "express";
import type { OwnerAuthenticator } from "./auth.ts";
import type { FirebaseServices } from "./config.ts";
import { audioHealth } from "./audioHealth.ts";
import { HttpError } from "./errors.ts";
import type { GeminiModelCheck } from "./gemini.ts";
import { readSettings } from "./settings.ts";
import { firebaseErrorCode, logFirebaseFailure } from "./firebaseErrors.ts";

// Reserved, read-only probe target. A 404 verifies permission to look up the
// object without requiring any object to be created in the shared bucket.
const probePath = "songs/_studio_setup_probe.wav";
const timeoutMs = 5_000;

async function check(operation: string, action: () => Promise<unknown>, authorization: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error("Firebase setup probe timed out."),
          { code: "ETIMEDOUT" })), timeoutMs);
      }),
    ]);
    return true;
  } catch (error) {
    logFirebaseFailure(operation, error, authorization);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function setupHealth(
  { db, bucket }: FirebaseServices, authenticate: OwnerAuthenticator, ownerCount: number, checkModel: GeminiModelCheck,
): RequestHandler {
  return async (req, res) => {
    res.set("Cache-Control", "no-store").vary("Authorization");
    if (Object.keys(req.query).length) {
      res.status(400).json({ ok: false });
      return;
    }
    const authorization = req.get("authorization");
    if (authorization === undefined) {
      res.json({ ok: true });
      return;
    }
    try {
      await authenticate(authorization);
    } catch (error) {
      res.status(error instanceof HttpError ? error.status : 503).json({ ok: false });
      return;
    }
    // The regular owner rate limiter uses Firestore. Run these read-only checks
    // independently so setup can still explain a Firestore permission failure.
    let textModel: string | null = null;
    const settings = check("setup_firestore", async () => { textModel = (await readSettings(db)).text_model; }, authorization);
    const [firestore, storage_read, storage_list, signed_url, audio, gemini_text_model_available] = await Promise.all([
      settings,
      check("setup_storage_read", async () => {
        try {
          await bucket.file(probePath).getMetadata();
        } catch (error) {
          if (firebaseErrorCode(error) !== "404" || !(error instanceof Error) ||
              !/no such object/i.test(error.message)) throw error;
        }
      }, authorization),
      check("setup_storage_list", () => bucket.getFiles({
        prefix: "songs/", maxResults: 1, autoPaginate: false,
      }), authorization),
      check("setup_sign_blob", async () => {
        const [url] = await bucket.file(probePath).getSignedUrl({
          version: "v4", action: "read", expires: Date.now() + 60_000,
        });
        if (!url) throw new Error("Cloud Storage returned no signed URL.");
      }, authorization),
      audioHealth(),
      settings.then((read) => checkModel(read ? textModel : null)),
    ]);
    const gemini_key_present = Boolean(process.env.GEMINI_API_KEY?.trim());
    // The application reads known object paths. Bucket-wide list permission
    // is unnecessary when the operator grants access via a prefix condition.
    const ok = firestore && storage_read && signed_url && ownerCount > 0 && gemini_key_present && gemini_text_model_available && audio.ffmpeg_master_test;
    res.status(ok ? 200 : 503).json({
      ok, token_verified: true, firestore, storage_read, storage_list, signed_url,
      owner_count: ownerCount, gemini_key_present, gemini_text_model: firestore ? textModel : null, gemini_text_model_available, ...audio,
    });
  };
}

export async function logRuntimeServiceAccount() {
  if (!process.env.K_SERVICE || process.env.STUDIO_EMULATOR === "1") return;
  try {
    const result = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", {
      headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal: AbortSignal.timeout(1_500),
    });
    if (!result.ok || result.headers.get("Metadata-Flavor") !== "Google") return;
    const account = (await result.text()).trim();
    if (/^[\w-]+@[\w.-]+\.gserviceaccount\.com$/.test(account)) {
      console.info(JSON.stringify({ event: "studio_runtime_identity", service_account: account }));
    }
  } catch {
    // Metadata may be unavailable in a preview. Cloud Run can still start.
  }
}
