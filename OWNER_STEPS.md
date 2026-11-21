# Owner steps for Darija Song Studio

## Configure AI Studio or Cloud Run

Set these runtime variables on the Studio service. Keep the Gemini key in the service's private secret configuration.

| Variable | What to set |
| --- | --- |
| `OWNER_EMAILS` | The comma-separated Google sign-in addresses allowed to manage the Studio. Use the identical list when rendering Firebase rules. |
| `AUTH_CHECK_REVOKED` | Leave unset or set to `0` for signature, issuer, audience and expiry verification. Set to `1` to also look up revoked sessions and disabled accounts after granting Firebase Auth Viewer. |
| `GEMINI_API_KEY` | The existing Gemini key for this app, stored as a runtime secret. |
| `STUDIO_DAILY_BUDGET_USD` | The fallback daily cap in USD. Start at `0` if you want Studio disabled for paid calls while verifying setup. **Settings & Rules → Daily Gemini budget** overrides the fallback and resets at midnight UTC. |
| `FFMPEG_PATH` | Optional path to an FFmpeg build containing `loudnorm` and `libmp3lame`. Leave unset to use the packaged binary or FFmpeg on `PATH`. |

The budget is a conservative reservation ledger, separate from the Gemini invoice. The current reservations are $0.04 for Lyria Clip, $0.08 for Lyria 3.5, $0.06 for audio analysis, $0.045 for a lyric draft, and $0.002 per text embedding. Retries reserve their own amount. Start with a small cap and review actual charges in Google before raising it. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

Use Node 22.13 or later, `npm ci`, `npm run build`, and `npm start` with `NODE_ENV=production`. The server listens on Cloud Run's `PORT`. Use a request timeout of at least 480 seconds for generation and batch drafting. Use Application Default Credentials via the Cloud Run service identity.

## Restore Firebase access for the runtime identity

The Firebase project is `tenten-accounting-app`. An AI Studio deployment can run in a different Google Cloud project. The Firebase Admin SDK uses the Cloud Run service account for Firestore and Storage. Checking revocation also requires access to Firebase Auth. Until the optional lookup is enabled, a previously issued ID token can remain valid until its expiry even if the account is disabled or its session is revoked. Removing an address from `OWNER_EMAILS` still blocks it on revisions that use the updated list. [Firebase session checks](https://firebase.google.com/docs/auth/admin/manage-sessions)

### Find the current service account and check setup

1. In Google Cloud Console, select the **project hosting the AI Studio deployment**. Open **Cloud Run → Services → the Studio service → Revisions**. Select the revision receiving traffic, open its **Security** tab, and copy the **Service account** address. If the service is not visible to you, ask the project administrator to identify the serving revision and its service account. [Cloud Run service identity](https://cloud.google.com/run/docs/configuring/services/service-identity)
2. In the runtime project, you can also open **Logging → Logs Explorer** and filter on `resource.type="cloud_run_revision"`, the Studio service name, and `jsonPayload.event="studio_runtime_identity"`. The startup event shows the metadata server's `service_account`. Use `jsonPayload.event="studio_firebase_failure"` to see the operation, error code and redacted message. The service account address is available in these logs and excluded from API responses.
3. Open `/api/health/setup` on the deployed host to check that the server responds with `{"ok":true}`. For detailed checks, call the same endpoint from an authenticated client that already has an allow-listed owner's Firebase ID token and can send the normal `Authorization: Bearer <Firebase ID token>` header. Keep that token inside the client. The detailed response reports token verification, the named Firestore read, object metadata access and listing under `songs/`, V4 signing, owner count and Gemini key presence. A failing required check returns HTTP 503 with its boolean set to false. `storage_list: false` can be expected with an object-prefix condition if object reads pass. Listing and paid Gemini calls are unnecessary for normal library loading.

### Option A — Grant the AI Studio runtime access

1. Switch to **tenten-accounting-app** in Google Cloud Console. Open **IAM & Admin → IAM → Grant access**. Enter the runtime service account as the new principal, select **Cloud Datastore User** (`roles/datastore.user`), and click **Add IAM condition → Condition editor**. Use a descriptive title and this expression, then click **Save** for the condition and the grant. The condition limits SDK access to the Studio database.

   ```cel
   resource.name == "projects/tenten-accounting-app/databases/ai-studio-darijareelstudio-5804899b-b609-44bd-a49e-61abf3fd4304"
   ```

   [Firestore per-database IAM](https://firebase.google.com/docs/firestore/manage-databases#configure_per-database_access_permissions)

2. Open **Cloud Storage → Buckets → tenten-accounting-app.firebasestorage.app → Objects**. On **songs**, open **More options → Edit access**. If uniform bucket-level access is already enabled and the console prompts to enable folder management, review the prompt and choose **Enable** for the `songs/` folder. In **Permissions for songs/ → Grant access**, add the runtime account as **Storage Object User** (`roles/storage.objectUser`). This scopes object access and listing to the managed folder. [Managed folder IAM](https://cloud.google.com/storage/docs/access-control/using-iam-for-managed-folders)
3. If managed-folder IAM is unavailable and the bucket already supports conditional IAM, use **Bucket → Permissions → Grant access** for **Storage Object User**, with **Add IAM condition → Condition editor** and the expression below. This permits known-path object access under `songs/`. It does not grant listing for the entire bucket. If neither scoped grant is supported, coordinate with the bucket owner before proceeding. Do not switch the shared bucket's access mode or grant unconditioned bucket access to resolve an individual check.

   ```cel
   resource.type == "storage.googleapis.com/Object" &&
   resource.name.startsWith("projects/_/buckets/tenten-accounting-app.firebasestorage.app/objects/songs/")
   ```

   [Bucket IAM conditions](https://cloud.google.com/storage/docs/access-control/using-iam-permissions)

4. Only if you set `AUTH_CHECK_REVOKED=1`, return to **tenten-accounting-app → IAM & Admin → IAM → Grant access** and grant the runtime account **Firebase Authentication Viewer** (`roles/firebaseauth.viewer`). Leave the setting at `0` if the role cannot be granted.
5. In the runtime service account's own project, open **APIs & Services → Library**, select **IAM Service Account Credentials API**, and click **Enable** if required. Open **IAM & Admin → Service Accounts → the runtime account → Permissions → Grant access**. Enter that same service account as the principal and grant **Service Account Token Creator** (`roles/iam.serviceAccountTokenCreator`) on that account. This lets it sign V4 URLs using `signBlob` without a downloaded key. [Cloud Storage URL signing](https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers)
6. After the grants take effect, repeat the setup check using the same served revision. Verify **Song Library** loads before attempting a migration or paid generation.

### Option B — Run the Studio in the Firebase project

1. In Google Cloud Console select **tenten-accounting-app**. Open **IAM & Admin → Service Accounts → Create service account** and create a dedicated Studio account. Apply the same database, `songs/` and signing grants above to that account. Keep the optional Firebase Auth grant conditional on `AUTH_CHECK_REVOKED=1`. Running in the same project still requires these permissions.
2. In that project open **Cloud Run → Services → Connect repo → Cloud Build → Set up with Cloud Build**. Select the Studio GitHub repository and the branch containing the reviewed release. Choose **Google Cloud Buildpacks** with the repo root as the build context, then click **Save**. Pick a service name and region and keep the previous service available during verification. Connecting the repository creates a trigger for subsequent pushes to the selected branch. [Cloud Run repository deployment](https://cloud.google.com/run/docs/quickstarts/deploy-continuously)
3. Under the new service's **Container(s), Volumes, Networking, Security** settings, choose the dedicated **Service account** under **Security**. In **Container(s) → Variables & Secrets**, set the table values above and `NODE_ENV=production`. Reference the existing Gemini secret from Secret Manager, keep the timeout at least 480 seconds, and choose **Allow public access** if Studio should be reachable by browsers and digitronics.ma. Firebase owner auth and partner-key auth remain enforced by Express. Click **Create** when ready.
4. In the Firebase console open **tenten-accounting-app → Authentication → Settings → Authorized domains → Add domain**. Add the new Cloud Run hostname. Check sign-in, the owner setup endpoint and the library on the new origin before changing the URL used by operators or digitronics.ma. [Firebase authorized domains](https://firebase.google.com/docs/auth/faq-and-troubleshooting#limit_authorized_domains)

## Apply Firebase rules and indexes

1. Check the target project and current bucket rules in Firebase. The Studio uses the named database recorded in [firebase.json](firebase.json). That file also names the bucket. If another app shares the bucket, preserve its existing policy outside `songs/` and make sure broad allow rules do not match Studio audio. Save a copy of the currently deployed policy before changing it.
2. Provide `OWNER_EMAILS` privately to your local shell, then run `npm run rules:render` from the repo root. Expect an ignored `.firebase-studio.generated.json` with the matching owner rules. Review the generated files locally. The committed templates deny direct access until populated.
3. Apply the named database rules and index using the generated config. Decline any prompt to delete a pre-existing index.

   ```sh
   npm exec -- firebase deploy --config .firebase-studio.generated.json --project tenten-accounting-app --only firestore:rules,firestore:indexes
   ```

4. The production bucket is shared with **AI Smart Accountant**. **Merge, never replace, its Storage rules.** The IAM fix above does not require a Storage rules deployment. If you separately need to update Studio Firebase rules, merge only the Studio owner check and `songs/` match into a copy of the active bucket policy. Preserve the Accountant rules and verify that broader allow rules do not also match Studio paths. Put the reviewed merged file in `.firebase/studio-rules/storage.rules`. Never deploy the standalone Studio template to this bucket.

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
