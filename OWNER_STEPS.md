# Owner steps for Darija Song Studio

## Configure AI Studio or Cloud Run

Set these runtime variables on the Studio service. Keep the Gemini key in the service's private secret configuration.

| Variable | What to set |
| --- | --- |
| `OWNER_EMAILS` | The comma-separated Google sign-in addresses allowed to manage the Studio. Use the identical list when rendering Firebase rules. |
| `GEMINI_API_KEY` | The existing Gemini key for this app, stored as a runtime secret. |
| `STUDIO_DAILY_BUDGET_USD` | The fallback daily cap in USD. Start at `0` if you want Studio disabled for paid calls while verifying setup. **Settings & Rules → Daily Gemini budget** overrides the fallback and resets at midnight UTC. |
| `FFMPEG_PATH` | Optional path to an FFmpeg build containing `loudnorm` and `libmp3lame`. Leave unset to use the packaged binary or FFmpeg on `PATH`. |

The budget is a conservative reservation ledger, separate from the Gemini invoice. The current reservations are $0.04 for Lyria Clip, $0.08 for Lyria 3.5, $0.06 for audio analysis, $0.045 for a lyric draft, and $0.002 per text embedding. Retries reserve their own amount. Start with a small cap and review actual charges in Google before raising it. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

Use Node 22.13 or later, `npm ci`, `npm run build`, and `npm start` with `NODE_ENV=production`. The server listens on Cloud Run's `PORT`. Use a request timeout of at least 480 seconds for generation and batch drafting. Use Application Default Credentials via the Cloud Run service identity. Give it access to the **named Studio Firestore database**, verified-token revocation checks in Firebase Auth, and object read/create in the Studio bucket. V4 signed URLs also need the IAM Service Account Credentials API and `iam.serviceAccounts.signBlob` on the signing identity. [Cloud Storage signing permissions](https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers)

## Apply Firebase rules and indexes

1. Check the target project and current bucket rules in Firebase. The Studio uses the named database recorded in [firebase.json](firebase.json). That file also names the bucket. If another app shares the bucket, preserve its existing policy outside `songs/` and make sure broad allow rules do not match Studio audio. Save a copy of the currently deployed policy before changing it.
2. Provide `OWNER_EMAILS` privately to your local shell, then run `npm run rules:render` from the repo root. Expect an ignored `.firebase-studio.generated.json` with the matching owner rules. Review the generated files locally. The committed templates deny direct access until populated.
3. Apply the named database rules and index using the generated config. Decline any prompt to delete a pre-existing index.

   ```sh
   npm exec -- firebase deploy --config .firebase-studio.generated.json --project tenten-accounting-app --only firestore:rules,firestore:indexes
   ```

4. For Storage, merge the generated owner rule into a shared bucket's existing policy and put the reviewed merged rules in `.firebase/studio-rules/storage.rules`. For an exclusive Studio bucket, the generated policy is ready to use. Deploy only after checking that other app prefixes work as expected.

   ```sh
   npm exec -- firebase deploy --config .firebase-studio.generated.json --project tenten-accounting-app --only storage
   ```

5. Verify the new revision and rules using an allow-listed Google account and a separate Google account outside the list. Confirm partner data remains private without a key. When changing the owner list, update both runtime and rules from the same list. Coordinate timing for removals so direct Firebase access is revoked as well.

If a legacy object already has a Firebase download token, changing the rules does not expire that old URL. The upgraded app neither returns nor relies on those tokens. Inventory and revoke legacy public tokens separately after checking other consumers and preserving the objects. [Firebase Storage download behavior](https://firebase.google.com/docs/storage/web/download-files)

## Run the catalog migration

1. Open the upgraded Studio with an owner account. In **Settings & Rules → Library maintenance**, press **Preview catalog migration**. Review the number of songs to migrate, default songs to seed and legacy takes to preserve. The preview leaves songs, takes and history unchanged.
2. Press **Apply catalog migration** and confirm. The Studio records completion counts in `studio_migrations` and Cloud Run logs. The action may be repeated after an interrupted run. A song with a generation in progress will be skipped, so rerun after the lease releases.
3. Verify **History** contains the catalog, counts appear under the correct status filters, and the first catalog songs show their expected Arabic lyrics and feelings. Expand **View all takes** to check older audio. If the lyrics changed, the old take remains playable with its original lyric revision and cannot be approved for the new lyrics.
4. To import outside history, press **Import history** in the same panel. Select a JSON file containing `[{ "source": "...", "id": "...", "feeling": "...", "title": "...", "lines": ["..."] }]`. The import skips duplicate source and ID pairs.

## Create the digitronics.ma integration key

1. Open **Settings & Rules → Partner API**. Enter **digitronics.ma** as the client name and press **Create key**. Copy the one-time value into MyVault and confirm you can find the saved entry.
2. Tick **Saved in MyVault** and press **Register key**. The key disappears from the Studio. The list shows the client name, revocation state and last use. Use **Revoke** when rotating or removing access.
3. Transfer the saved value privately to the digitronics.ma server's secret configuration. Send it only in the HTTPS header `Authorization: Bearer <key>`. Keep it out of browser code, URL parameters, logs and Git.
4. Make a server-side `GET /api/v1/songs?status=approved&limit=50`. If `next_cursor` is present, use it with the same filters on the next request. `updated_since` is exclusive. Use each song's `id` for `GET /api/v1/songs/<id>/audio?format=wav` or `format=mp3`, verify the SHA-256, and download before the URL expires.
5. Record import outcomes with `POST /api/v1/songs/<id>/ack` and JSON `{ "system": "digitronics.ma", "external_id": "...", "result": "imported" }`. Use `"rejected"` and an optional `reason` for a rejection. Owners can see those results in the song detail.

## Local checks without paid calls

Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. With Java 21 installed, run `npm run test:emulators` for a disposable Firebase project. The test command targets only `demo-darija-studio` and does not require any Gemini key.
