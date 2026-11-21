import type { GenerationStage } from "../src/lib/songRepair.ts";
import { MasteringError } from "./audio.ts";
import { diagnosticMessage, firebaseErrorCode } from "./firebaseErrors.ts";

export function logGenerationFailure(songId: string, takeId: string | null, stage: GenerationStage, error: unknown) {
  const failedStage = error instanceof MasteringError ? error.stage : stage;
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const stderr = cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string"
    ? cause.stderr.trim().split(/\r?\n/).slice(-4).join(" ") : "";
  const message = diagnosticMessage(stderr || (cause instanceof Error ? cause.message : "Generation failed."));
  const code = firebaseErrorCode(cause);
  const name = cause instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(cause.name) ? cause.name : "Error";
  console.error(JSON.stringify({
    event: "generation_failed", song_id: songId, take_id: takeId, stage: failedStage,
    error_name: name, error_code: code, message,
  }));
  return { stage: failedStage, message: message.slice(0, 180) };
}
