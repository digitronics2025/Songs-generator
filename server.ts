import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { parseOwnerEmails } from "./src/lib/ownerEmails.ts";
import { firebaseServices, type FirebaseServices } from "./server/config.ts";
import { createOwnerAuthenticator } from "./server/auth.ts";
import { HttpError } from "./server/errors.ts";
import { DATA_CONFIGURATION, firebaseDataUnavailable, logFirebaseFailure } from "./server/firebaseErrors.ts";
import { ownerRouter } from "./server/owner.ts";
import { partnerRouter } from "./server/partner.ts";
import { logRuntimeServiceAccount, setupHealth } from "./server/setupHealth.ts";

export function createApp(services: FirebaseServices, emails: string[]) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  const authenticate = createOwnerAuthenticator(services.auth, emails);
  app.get("/api/health/setup", setupHealth(services, authenticate, emails.length));
  app.use("/api/v1", partnerRouter(services));
  app.use("/api", ownerRouter(services, authenticate));
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
    } else if (error instanceof ZodError) {
      res.status(400).json({ error: "Invalid request fields." });
    } else if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Request too large." });
    } else if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON." });
    } else if (firebaseDataUnavailable(error)) {
      logFirebaseFailure("data_access", error, req.get("authorization"));
      res.status(503).json({ error: DATA_CONFIGURATION });
    } else {
      console.error(JSON.stringify({ event: "studio_request_failed", name: error instanceof Error ? error.name : "Error",
        code: typeof error?.code === "number" ? error.code : null }));
      res.status(500).json({ error: "Studio request failed." });
    }
  };
  app.use(errors);
  return app;
}

async function start() {
  const app = createApp(firebaseServices(), parseOwnerEmails(process.env.OWNER_EMAILS));
  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const dist = path.resolve("dist");
    app.use(express.static(dist));
    app.get("/{*path}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, "0.0.0.0", () => {
    console.info("Darija Song Studio listening on port " + port);
    void logRuntimeServiceAccount();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => {
    console.error("Darija Song Studio failed to start. Check Firebase and environment configuration.");
    process.exitCode = 1;
  });
}
