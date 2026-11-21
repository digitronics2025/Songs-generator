# Security Specification — Darija Reel Studio

## Data Invariants
1. **Authentication & Verified Email**: Every read and write to `/songs/{songId}` requires a verified Firebase Google user (`request.auth != null && request.auth.token.email_verified == true`).
2. **Ownership & Studio Admin**: Documents in `/songs/{songId}` belong to `ownerId == request.auth.uid` (or the studio owner `contact@tenten.ma` with verified email). Unauthenticated or unauthorized users are rejected.
3. **Immutable Identity & Filename Keys**: On update, `ownerId`, `number`, `feeling_key`, and `file_name` cannot be modified.
4. **Strict Field Allowlisting**: Document creation requires all base fields and forbids unknown keys. Updates are split into explicit action shapes (`edit_lyric_and_feeling` vs `generation_and_quality_result`).
5. **Bounded Strings, Arrays & Numbers**: Every string field enforces `.size()` limits, `number` is bounded `1..20`, `tempo_bpm` is bounded `70..100`, `admin_feeling` is constrained to the 8 allowed keys, `lines` is bounded `1..8` strings (each `<= 240`), `words_heard_pct` is `0..100`, `voice_start_seconds`/`voice_end_seconds` are `0..300`, and `missing_words`/`extra_words` are bounded to `<= 50` strings.

## Dirty Dozen Payloads (Rejected by Rules)
1. Unauthenticated `get`/`list`/`create`/`update` on `/songs/1`.
2. Unverified email (`email_verified: false`) attempting write on `/songs/1`.
3. Cross-user read/write where `ownerId != request.auth.uid` and user is not studio admin.
4. Shadow field injection (`extraAdminFlag: true`) on create or update.
5. Path poisoning (`songId` > 128 chars or containing invalid symbols).
6. Mutating `ownerId` or `number` during update.
7. Mutating `feeling_key` or `file_name` during update.
8. Setting `admin_feeling` to an unlisted value (e.g. `"unknown_feeling"`).
9. Setting `lines` to an empty array or > 8 lines.
10. Setting `words_heard_pct` > 100 or negative, or `voice_start_seconds` < 0.
11. Injecting > 50 elements into `missing_words` / `extra_words` or > 2000 chars into `transcribed_text`.
12. Attempting `delete` on `/songs/1` (all deletes are denied).
