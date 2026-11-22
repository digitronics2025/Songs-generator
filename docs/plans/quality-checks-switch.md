# Plan: "Quality checks" switch (one take per song, no audits)

## Goal
Add one switch in **Settings & Rules**, called "Quality checks". It is OFF by default.
When it is OFF:
- No Gemini transcription.
- No pass/fail on words heard, voice start/end, length, loudness or peak.
- No automatic repair (remaster, lyric rewrite or extra take).
- Each song has one take. "Generate Take" becomes "Regenerate", which replaces the current audio and approves the song automatically.

When it is ON, the app must work exactly as it does today.

## Decisions already made
- Regenerating does NOT delete the old audio. The old take stays in Firestore/Storage and stays in History, but it is hidden from the song row.
- Mastering still runs ONCE so loudness stays consistent. The second re-master pass (`server/generation.ts` ~line 210) is skipped.
- Autopilot needs the checks to decide which takes qualify. While checks are OFF, autopilot cannot run: the server refuses to start a run, and the Settings page shows why.

## Steps

### 1. Setting
- `src/data/songs.ts`: add `quality_checks: boolean` to `StudioSettings`, and `quality_checks: false` to `DEFAULT_STUDIO_SETTINGS`.
- `server/schemas.ts`: add `quality_checks: z.boolean().optional()` to `studioSettings`. Do not change `server/settings.ts`: `settingsFromDocument` already merges defaults by schema key. Check that this is true.
- `firestore.rules` (and `scripts/render-rules.ts` if the rules are generated): allow the new key on `settings/app_settings` writes. Then run `npm run rules:render`.

### 2. Server: generation (`server/generation.ts`, `generateTake`)
Read `settings.quality_checks` (`settings` is already loaded inside the claim transaction). When it is false:
- Plain `"generate"` request: create the take as today. Then do music → raw upload → `masterWav` once → WAV upload. Skip the second master pass. Do NOT call `checkVocals`/`gemini.transcribe`. Set `vocalPending = false`.
- `failures`: use `[]` instead of `audioFailures(metrics)`. A take with a stored WAV is `status: "ready"` and `passed_all_checks: true`. A real error (`PROCESSING_ERROR`) still fails the take.
- After saving, auto-approve: in the final transaction, set the take to `is_approved: true, approved_at`, and set the song to `status: "approved", approved_take_id, best_take_id` plus `takeProjection(takeData)`. This replaces the previous audio on the song. The old take is left untouched.
- `"repair"` and `{ checkVocals }` requests: reject with `HttpError(409, "Quality checks are off.")` before any paid call.
- Regenerating an already-approved song must be allowed. Today `promote` is false when `wasApproved`. Keep that behaviour when checks are ON, and promote anyway when checks are OFF.
- The daily take limit (`checkGenerationLimits`) still applies.

### 3. Server: routes and autopilot
- `server/owner.ts` (~lines 144 and 152): the repair and check-vocals routes return 409 when checks are off (the guard in step 2 does this; just make sure the error reaches the client).
- `server/catalog.ts` `selectTake`: no change needed, because takes made with checks off already have `passed_all_checks: true`.
- Autopilot start (find the route or function that starts a run, `grep -n "autopilot" server/*.ts`): refuse with 409 "Turn on Quality checks to use autopilot" when `quality_checks` is false. `server/autopilotWork.ts` must also stop doing anything if the setting turns off while a run is in progress.

### 4. Client
- `src/components/SettingsView.tsx`: add a toggle "Quality checks". Helper text: "Off: one take per song, no transcription or audits, the song is approved as soon as audio is ready. On: multiple takes, transcription, automatic repair." When the toggle is OFF, disable the autopilot controls and show the reason.
- `src/components/SongRow.tsx`, when `settings.quality_checks === false`:
  - Hide the Takes panel (~lines 372–470), the "Words heard / Voice" metrics bar (~line 331), the "Repair log and partner acknowledgements" section, and the "(N takes)" text (~line 251).
  - Rename "Generate Take" (~line 678) to "Regenerate". If the song already has audio, ask for confirmation first ("Replace the current audio?").
  - Keep the LUFS/dBTP readout only if it fits without the metrics bar. Otherwise hide it.
- Pass `settings` down from wherever `SongRow` is rendered (`src/App.tsx` / `useStudio`) if it is not already available.
- `src/hooks/useSongActions.ts`: hide or disable any "repair" / "check vocals" action when checks are OFF.

### 5. Tests (vitest)
Mock Gemini/Lyria the same way the existing tests in `tests/` do.
- With checks OFF, a generated take: transcribe is never called; the take is `ready`, `passed_all_checks: true`, `is_approved: true`; the song is `approved` with the new take's `storage_path`.
- Regenerating an approved song with checks OFF: the song now points to the new take, and the old take document still exists.
- With checks OFF, `"repair"` and `{ checkVocals }` return 409, and no Gemini call is made.
- With checks ON, all existing tests pass unchanged.
- `settingsFromDocument({})` returns `quality_checks: false`, and `settingsFromDocument({ quality_checks: true })` returns `true`.
- Starting autopilot with checks OFF returns 409.

### 6. Verify
```
npm run typecheck && npm run lint && npm test
```
If the Firebase emulators are available, also run `npm run test:emulators`. Then run `npm run dev`. Generate a song with checks OFF and confirm there is one take, no "Words heard" bar, and the song is approved. Turn checks ON and confirm the old behaviour is back.

## Out of scope
- Deleting old takes or old audio files.
- Changing the mastering targets.
- Any change to the lyric rules (forbidden words, words per line).
