# Rotating Backblaze B2 Application Keys

## When to use this runbook

- B2 uploads fail in the browser with `403 SignatureDoesNotMatch` and a
  misleading "blocked by CORS policy" message.
- `b2_authorize_account` returns `401 unauthorized` for the current key.
- Routine key rotation.

The browser CORS message is a **red herring**: B2 returns 403 on auth failure
without CORS headers, so the browser reports it as a CORS error. The real
diagnostic is `b2_authorize_account` below.

## Verified facts about this project

- Bucket: `audiobookphile-b2-secondary` (S3-compatible endpoint:
  `https://s3.us-west-004.backblazeb2.com`, region `us-west-004`).
- Edge Function consuming the key: `upload-presign` (writes) and
  `_shared/storage-router.ts` (reads) — both read `B2_SECONDARY_KEY_ID` /
  `B2_SECONDARY_APP_KEY` from the Supabase secret store at runtime.
- The `edge-functions.yml` deploy workflow ships function code only. It does
  **not** push secrets. Secrets must be set separately.
- Bucket CORS is already configured correctly on the B2 side (verified via
  preflight). Do not touch CORS while debugging an auth failure.

## Rotation steps

### 1. Create the new key in Backblaze

B2 web UI → **Buckets** → `audiobookphile-b2-secondary` → **Application Keys**
(or the account-wide Application Keys page). Grant:

- **Read & Write** capability
- Bucket-restricted to `audiobookphile-b2-secondary` (not all buckets)
- Name prefix: `audiobookphile-secondary` (or your team's convention)

Record the **keyID** (starts with `004…`) and **applicationKey** (only shown
once).

### 2. Verify the new key works before deploying

```bash
NEW_KEY_ID=<paste>
NEW_APP_KEY=<paste>

# Should return 200 with JSON containing apiUrl + authorizationToken.
curl -sS -u "$NEW_KEY_ID:$NEW_APP_KEY" \
  "https://api.backblazeb2.com/b2api/v3/b2_authorize_account"
```

If this returns `401`, the key is dead on arrival — do not proceed. Re-create it.

### 3. Update the Supabase secret store

The Edge Functions read from Supabase secrets, not from `.env`. Update both:

```bash
cd audiobookphile-backend

bunx supabase secrets set \
  B2_SECONDARY_KEY_ID="$NEW_KEY_ID" \
  B2_SECONDARY_APP_KEY="$NEW_APP_KEY" \
  --project-ref iambzzclljayqdxkeepy
```

No function redeploy is required — secrets are picked up on the next cold start.
To force a cold start immediately, redeploy the affected functions:

```bash
bunx supabase functions deploy upload-presign --project-ref iambzzclljayqdxkeepy
```

### 4. Update local `.env`

```bash
# audiobookphile-backend/.env
B2_SECONDARY_KEY_ID=<NEW_KEY_ID>
B2_SECONDARY_APP_KEY=<NEW_APP_KEY>
```

### 5. End-to-end verification

From the running app (logged in as admin/root), upload a small test MP3. The
Network tab should show:

1. `POST /functions/v1/upload-presign` → `200`
2. `PUT s3.us-west-004.backblazeb2.com/...` → `200` (not 403)

Or, headlessly:

```bash
# Get a valid admin JWT first, then:
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{"filename":"rotation-test.mp3","contentType":"audio/mpeg"}' \
  "https://iambzzclljayqdxkeepy.supabase.co/functions/v1/upload-presign"
# Expect: 200 with {"url":"https://s3...","provider_prefix":"b2-secondary://"}

# Then PUT a small body to the returned URL:
curl -sS -X PUT -d "test" "<url from above>"
# Expect: 200 and an ETag header
```

### 6. Revoke the old key

In B2, delete the old application key (`004dad4b095de370000000001` or whichever
was rotated). Confirm no service still depends on it first.

## Primary tier

The primary B2 bucket (`B2_KEY_ID` / `B2_APP_KEY` / `B2_BUCKET_NAME`) uses the
same flow with the primary-tier variable names. `ACTIVE_B2_TIER=secondary` is
currently set, so the primary path is dormant in production — rotate it only
when switching tiers or during a full audit.
