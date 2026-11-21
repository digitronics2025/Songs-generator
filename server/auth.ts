import type { RequestHandler } from "express";
import type { FirebaseServices } from "./config.ts";
import { HttpError } from "./errors.ts";
import { authFailure, logFirebaseFailure } from "./firebaseErrors.ts";

export function bearer(header: string | undefined): string {
  const token = /^Bearer ([^\s,]{1,8192})$/i.exec(header ?? "")?.[1];
  if (!token) throw new HttpError(401, "Authentication required.");
  return token;
}

export function createOwnerAuthenticator(
  auth: FirebaseServices["auth"],
  emails: string[],
  checkRevoked = process.env.AUTH_CHECK_REVOKED === "1",
) {
  const allowed = new Set(emails);
  return async (authorization: string | undefined) => {
    const token = bearer(authorization);
    const identity = await auth.verifyIdToken(token, checkRevoked).catch((error: unknown) => {
      const failure = authFailure(error);
      if (failure.status === 503) logFirebaseFailure("verify_sign_in", error, authorization);
      throw failure;
    });
    if (!identity.email_verified || identity.firebase?.sign_in_provider !== "google.com" ||
        !allowed.has(identity.email?.toLowerCase() ?? "")) {
      throw new HttpError(403, "This Google account is not allowed.");
    }
    return identity.uid;
  };
}

export type OwnerAuthenticator = ReturnType<typeof createOwnerAuthenticator>;

export function ownerAuth(authenticate: OwnerAuthenticator): RequestHandler {
  return async (req, res, next) => {
    res.locals.uid = await authenticate(req.get("authorization"));
    next();
  };
}
