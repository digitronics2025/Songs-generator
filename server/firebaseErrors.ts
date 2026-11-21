import { HttpError } from "./errors.ts";

export const SIGN_IN_CONFIGURATION = "Server cannot verify sign-ins (configuration)";
export const DATA_CONFIGURATION = "Server cannot access Firebase data (configuration)";

function errorDetails(error: unknown) {
  if (typeof error !== "object" || error === null) return {};
  return error as { code?: unknown; message?: unknown; response?: { status?: unknown }; name?: string };
}

export function firebaseErrorCode(error: unknown) {
  const { code, response } = errorDetails(error);
  const value = (typeof code === "number" || typeof code === "string") ? String(code) : "";
  if (/^(?:[0-9]{1,3}|[A-Z][A-Z0-9_]{1,48}|[a-z-]{2,24}\/[a-z-]{2,48}|permission-denied|unauthenticated|insufficient-permission)$/.test(value)) return value;
  const status = response?.status;
  return typeof status === "number" ? String(status) : "unknown";
}

export function authFailure(error: unknown) {
  switch (firebaseErrorCode(error)) {
    case "auth/id-token-expired":
      return new HttpError(401, "Your sign-in token expired. Sign in again.");
    case "auth/id-token-revoked":
    case "auth/user-disabled":
    case "auth/user-not-found":
      return new HttpError(401, "Your sign-in session is no longer active. Sign in again.");
    case "auth/argument-error":
    case "auth/invalid-argument":
    case "auth/invalid-id-token":
    case "auth/tenant-id-mismatch":
      return new HttpError(401, "Invalid sign-in token.");
    default:
      // An unrecognized verification failure still denies access.
      return new HttpError(503, SIGN_IN_CONFIGURATION);
  }
}

const accessCodes = new Set([
  "7", "16", "401", "403", "UNAUTHENTICATED", "PERMISSION_DENIED",
  "permission-denied", "unauthenticated", "insufficient-permission",
  "app/invalid-credential", "auth/invalid-credential", "auth/insufficient-permission",
  "serviceusage.services.use", "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "4", "14", "503", "504", "UNAVAILABLE", "DEADLINE_EXCEEDED", "ECONNRESET", "ETIMEDOUT",
  "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED",
]);

export function firebaseDataUnavailable(error: unknown) {
  if (error instanceof HttpError) return false;
  const details = errorDetails(error);
  const message = typeof details.message === "string" ? details.message : "";
  // The Cloud Storage SDK wraps signBlob failures and can discard HTTP status.
  return details.name === "SigningError" ||
    accessCodes.has(firebaseErrorCode(error)) || [401, 403, 503, 504].includes(Number(details.response?.status)) ||
    /PERMISSION_DENIED|UNAUTHENTICATED|Could not load the default credentials|Unable to detect a Project Id|database .+ does not exist/i.test(message);
}

export function logFirebaseFailure(operation: string, error: unknown, authorization?: string) {
  const details = errorDetails(error);
  let message = typeof details.message === "string" ? details.message : "Firebase request failed.";
  const submittedToken = authorization?.match(/^\s*Bearer\s+(\S+)/i)?.[1];
  for (const secret of [authorization, submittedToken, process.env.GEMINI_API_KEY]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  message = message
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(?:AIza[\w-]{20,}|dss_[\w-]{43}|ya29\.[\w-]+)\b/g, "[redacted]")
    .replace(/\b(?:[a-z_-]*token|api[_ -]?key|client[_ -]?secret|private[_ -]?key|password|x-goog-signature)["']?\s*[:=]\s*["']?[^\s,;"'&}\]]+/gi, "[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\s+/g, " ")
    .slice(0, 500);
  console.warn(JSON.stringify({ event: "studio_firebase_failure", operation, code: firebaseErrorCode(error), message }));
}
