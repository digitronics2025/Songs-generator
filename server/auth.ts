import type { RequestHandler } from "express";
import { HttpError } from "./errors.ts";

export function bearer(header: string | undefined): string {
  const token = /^Bearer ([^\s,]{1,8192})$/i.exec(header ?? "")?.[1];
  if (!token) throw new HttpError(401, "Authentication required.");
  return token;
}

interface Identity {
  uid: string;
  email?: string;
  email_verified?: boolean;
  firebase?: { sign_in_provider: string };
}

export function ownerAuth(verify: (token: string) => Promise<Identity>, emails: string[]): RequestHandler {
  const allowed = new Set(emails);
  return async (req, res, next) => {
    try {
      const token = bearer(req.get("authorization"));
      const identity = await verify(token).catch(() => {
        throw new HttpError(401, "Invalid or expired sign-in session.");
      });
      if (!identity.email_verified || identity.firebase?.sign_in_provider !== "google.com" ||
          !allowed.has(identity.email?.toLowerCase() ?? "")) {
        throw new HttpError(403, "This Google account is not authorized for the studio.");
      }
      res.locals.uid = identity.uid;
      next();
    } catch (error) {
      next(error);
    }
  };
}
