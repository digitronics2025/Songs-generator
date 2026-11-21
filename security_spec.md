# Darija Song Studio security specification

## Identity and access

- The Studio API checks a verified Firebase ID token with provider `google.com`, revocation status and a case-insensitive email in `OWNER_EMAILS`. Missing or invalid tokens receive 401. Valid non-owner identities receive 403. An empty allow-list denies all owner sessions.
- The partner API under `/api/v1` uses separate scoped bearer keys. The browser generates a 256-bit key once and registers its SHA-256 digest after the owner confirms vault custody. Firestore stores the digest and metadata. Route responses and logs exclude raw keys and hashes.
- Partner calls are logged with the route name, method, status, client ID where known and duration. A Firestore transaction enforces a rolling 60 requests per minute per partner and updates last use. Studio routes also have a per-user rolling limit and a smaller paid-operation limit.
- Firebase rules use the owner list rendered from the same environment value. Direct Firestore and Storage writes are denied, including to owners. Studio writes go through the authenticated server. Partner acknowledgements are scoped to approved songs. Internal collections are private to the server.

## Generation and publication

- The server validates request shapes and reads the current song spec from Firestore. All Gemini dispatches, including retries, reserve estimated USD costs in a Firestore transaction before dispatch. A UTC day budget of zero disables paid calls. Unused estimates are retained for the day so failed or ambiguous calls cannot reopen budget.
- An expiring Firestore lease serializes generation, repair and edits by song. Generation reserves a take before work starts. Finalization checks the token and expiry. There are at most four takes per song and two automatic repair jobs per UTC day. The runtime creates unique objects with an object-generation precondition and never deletes an audio object.
- FFmpeg analyzes the final mastered WAV. Gemini transcribes the resulting audio and estimates vocal timing. Missing measurements fail quality checks. Approval requires a passing take for the current title and lyric revision. Editing a lyric retains previous takes and returns the song to draft. An approved take remains immutable.
- Audio reads use Storage SDK calls against the configured bucket and exact Studio path shapes. The proxy is GET-only and never fetches caller-supplied URLs. Partner links sign the specific object generation for 15 minutes. MP3 exports use a content-addressed cache, 44.1 kHz, stereo and 128 kbps CBR.
- React renders lyric and API strings as text. Song creation checks normalized title, every lyric line, three consecutive words, unique-word overlap, and Gemini embeddings against saved history and the current batch. The catalog version prevents concurrent saves from accepting a stale duplicate check.

## Data changes

The catalog migration is owner-triggered and supports a read-only preview. It snapshots changed legacy lyrics, adds history and legacy takes, and preserves old fields and storage references. The version marker and per-song transaction make retries safe. Imported history is keyed by source and external ID. New song, edit, archive, restore and lyric approval writes record history in the same transaction as the change.

The Studio may share a project or bucket with other apps. See [OWNER_STEPS.md](OWNER_STEPS.md) for the named database, shared Storage rules and previously issued Firebase download-token URLs.
