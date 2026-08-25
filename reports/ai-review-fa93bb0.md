# AI review `HEAD~3..HEAD` @ fa93bb0

Provider: zai · 10 finding(s) (2 critical, 4 major)

## [CRITICAL] .github/workflows/daily-compat.yml:48
- **Issue:** The L1 Deno Unit Tests step uses `grep -q "0 failed"` to determine success. If the test runner outputs '0 failed' in a failure context (e.g., inside a stack trace or error message), or if the output format changes slightly, the step will report success despite test failures. This creates a false sense of security for the production compatibility gate.
- **Suggested fix:** Rely on the exit code of `deno test` directly. Remove the `grep` check and ensure the script fails if `deno test` returns a non-zero exit code. For example: `deno test --allow-all --no-check=remote api/ || exit 1`.

## [CRITICAL] .github/workflows/daily-compat.yml:69
- **Issue:** The L3 Playwright step uses `grep -qE "[1-9][0-9]* passed"` to verify success. This logic fails if exactly 0 tests pass (e.g., a configuration error prevents test discovery) or if the output format varies. It risks masking total test failures as success.
- **Suggested fix:** Configure Playwright to exit with a non-zero code on failure (default behavior) and remove the `grep` validation. Ensure the workflow step fails if the command returns a non-zero exit code.

## [MAJOR] scripts/ai_probe.ts:234
- **Issue:** The AI probe script creates a user via the Admin API but does not verify the creation success or handle potential errors (e.g., rate limits, invalid email format) before attempting to log in. If user creation fails silently, the subsequent login will fail, causing the entire probe to abort or report false positives/negatives.
- **Suggested fix:** Check the response status of the user creation request. If it fails, throw an error or log a critical failure and exit gracefully, rather than proceeding with an invalid state.

## [MAJOR] scripts/ai_probe.ts:274
- **Issue:** The cleanup logic attempts to delete profiles using a `LIKE` query on `username`. If the `ai-probe-` prefix is not unique or if the query matches unintended rows, it could cause data loss. Additionally, the `mgmt` token check happens inside the block, but the `ref` extraction relies on a regex that might fail on non-standard Supabase URLs.
- **Suggested fix:** Use a more specific identifier for cleanup (e.g., store the created user ID and delete by ID). Ensure the regex for `ref` is robust or handle the case where it fails to match.

## [MAJOR] supabase/functions/_shared/storage-router.ts:284
- **Issue:** The `probeKey` method attempts to list files in Supabase Storage using `list(folder, { search: filename })`. The `search` parameter performs a substring match, not an exact match. If a filename like 'track1.mp3' exists, searching for 'track.mp3' would incorrectly find it, potentially serving the wrong file.
- **Suggested fix:** After retrieving the list, explicitly filter the results in code to ensure `f.name === filename` before signing the URL.

## [MAJOR] supabase/functions/api/playbackService.ts:476
- **Issue:** The self-heal logic iterates over `signedTrackResults` and calls `storage.signFirstExisting` for dead paths. However, the code does not persist the healed paths back to the database (`library_items.audio_files`). While the session is healed for the current user, the next user playing the same item will hit the same dead paths and incur the same latency/cost of re-probing.
- **Suggested fix:** After successfully resolving a new path via `signFirstExisting`, update the `audio_files` JSONB column in the database for the specific `libraryItemId` to reflect the new `canonicalPath` or `storagePath`.

## [MINOR] .github/workflows/daily-compat.yml:16
- **Issue:** The workflow runs on `self-hosted, macOS`. If the macOS runner is unavailable or fails to boot, the daily compatibility check will be skipped entirely without alerting, assuming no other runners are configured as fallbacks.
- **Suggested fix:** Ensure there is a fallback mechanism (e.g., a matrix with standard GitHub-hosted runners) or an alerting setup if the self-hosted runner goes offline.

## [MINOR] supabase/functions/_shared/zai.ts:419
- **Issue:** The sanity check for `publishedYear` uses a regex `/^\d{4}$/`. This will reject valid historical years (e.g., '0200' for 200 AD) or future years, potentially stripping valid metadata from older books.
- **Suggested fix:** Adjust the validation logic to allow a wider range of numeric years (e.g., 4 digits, or a numeric range check) rather than strictly enforcing 4 digits if the data includes ancient works.

## [MINOR] supabase/functions/repair_metadata.ts:269
- **Issue:** The `minority` check logic `stowaways.length <= Math.ceil(entries.length * 0.2)` is skipped if `onlyId` or `onlyIds` is set. When repairing a specific item, the script will not detach zero-duration files even if they are clearly stowaways, potentially leaving the item in a broken state.
- **Suggested fix:** Remove the `!targeted` condition from the `if` statement so that stowaway removal logic applies regardless of whether the run is targeted or global.

## [MINOR] supabase/functions/api/routes/search.ts:268
- **Issue:** The `ZAI_EMBEDDING_MODEL` defaults to 'embedding-3', which the comment suggests is retired. If the environment variable is not set, the API will call a retired model, likely resulting in 5xx errors for semantic search features.
- **Suggested fix:** Update the default value to a valid, active embedding model name, or remove the default and fail fast if the variable is not configured.

