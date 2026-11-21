import { OAuth2Client, type VerifyIdTokenOptions } from "google-auth-library";
import { bearer, type OwnerAuthenticator } from "./auth.ts";
import { HttpError } from "./errors.ts";

const google = new OAuth2Client({ transporterOptions: { timeout: 5_000, retry: false } });

type VerifyScheduler = (options: VerifyIdTokenOptions) => Promise<{ getPayload: () =>
  { email?: string; email_verified?: boolean } | undefined }>;

export function createAutopilotAuthenticator(authenticateOwner: OwnerAuthenticator,
  verify: VerifyScheduler = (options) => google.verifyIdToken(options)) {
  return async (authorization: string | undefined) => {
    const idToken = bearer(authorization);
    try {
      return { owner: await authenticateOwner(authorization) };
    } catch (error) {
      const email = process.env.AUTOPILOT_INVOKER_SA?.trim().toLowerCase();
      const audience = process.env.AUTOPILOT_AUDIENCE?.trim();
      if (!audience || !email || !/^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$/.test(email) ||
          !(error instanceof HttpError) || error.status === 403) throw error;
      let payload: ReturnType<Awaited<ReturnType<VerifyScheduler>>["getPayload"]>;
      try { payload = (await verify({ idToken, audience })).getPayload(); }
      catch { throw error; }
      if (payload?.email_verified !== true || payload.email?.toLowerCase() !== email) {
        throw new HttpError(403, "This Google service account cannot run Autopilot.");
      }
      return { owner: null };
    }
  };
}
