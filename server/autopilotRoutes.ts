import { json, Router } from "express";
import type { OwnerAuthenticator } from "./auth.ts";
import { getAutopilotStatus, runAutopilot } from "./autopilot.ts";
import { createAutopilotAuthenticator } from "./autopilotAuth.ts";
import type { FirebaseServices } from "./config.ts";
import { rateLimit } from "./limits.ts";
import { empty } from "./schemas.ts";

export function autopilotRouter(services: FirebaseServices, authenticateOwner: OwnerAuthenticator,
  authenticateRun = createAutopilotAuthenticator(authenticateOwner)) {
  const api = Router();
  api.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  api.get("/", async (req, res) => {
    const owner = await authenticateOwner(req.get("authorization"));
    empty.parse(req.query);
    await rateLimit(services.db, "owner", owner, 120);
    res.json(await getAutopilotStatus(services.db));
  });
  api.post("/run", json({ limit: "1kb", strict: true }), async (req, res) => {
    const principal = await authenticateRun(req.get("authorization"));
    empty.parse(req.query);
    empty.parse(req.body ?? {});
    if (principal.owner !== null) await rateLimit(services.db, "owner", principal.owner, 120);
    res.json(await runAutopilot(services, principal));
  });
  return api;
}
