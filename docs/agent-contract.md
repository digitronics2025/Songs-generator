# Song Studio agent contract

This repository owns Darija Song Studio. Read [OWNER_STEPS.md](../OWNER_STEPS.md)
for the owner-managed runtime and [security_spec.md](../security_spec.md) before
touching authentication, Firebase access, generation, storage, exports or migrations.

## Source, checks and release

- `main` is the application source. Preserve the existing Firebase project,
  shared Storage bucket, Cloud Run service identity, domain, limits and data.
- Use Node 22.18 or later. Install with `npm ci --include=optional`.
- The verified checks are `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run test:emulators` (Java 21; disposable `demo-darija-studio` project),
  and `npm run build`. `.github/workflows/checks.yml` runs these checks for pull
  requests and pushes to `main`.
- No repository workflow deploys the production service. The owner manages the
  AI Studio or Cloud Run release described in `OWNER_STEPS.md`. A GitHub merge
  is not proof of a live deployment. Do not publish, change runtime settings,
  IAM, Firebase rules, service accounts or production secrets without explicit
  owner authorization and the documented provider steps.
- Rule changes must use `npm run rules:render` and the repository's verification workflow.
  Preserve the rules for other applications that share the Firebase project or
  bucket. Review any migration with its read-only preview and obtain owner
  approval before applying it.

## Data, credentials and paid operations

- Treat songs, lyrics, owner identities, partner keys and Firebase records as
  private. Use synthetic fixtures for tests. Do not put secrets or personal
  data in logs, memory, output or Git.
- Follow the shared MyVault custody workflow for credentials. Keep Gemini keys
  and partner API keys in their existing secret stores; never expose or rotate
  them as part of an ordinary code change.
- Gemini generation, embeddings, audio analysis and catalog migration can incur
  cost or change production data. Advice and investigation stay read-only.
  Make paid calls or live data changes only when the user explicitly requests
  that work and its scope is clear; keep within the configured daily budget.

## Advice, review and implementation

- For open-ended improvement requests, cover the relevant user workflows and
  distinct practical options before prioritizing them. Explain expected value
  and material tradeoffs. Honor a requested shortlist or exact format.
- Defect reviews lead with verified findings. Improvement reviews also consider
  usability, accessibility, recovery and owner workflows when relevant.
- Implement only when asked. Preserve the owner approval boundary, shared
  service identity and application behavior. Follow the repository checks and
  normal pull request process for changes.
