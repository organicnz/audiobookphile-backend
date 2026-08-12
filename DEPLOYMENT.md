# Deployment Guide

> ## Deploying via CI/CD (standard path — no credentials needed)
>
> **All migrations and Edge Function deploys are handled by the GitHub
> Actions pipeline (`.github/workflows/deploy-backend.yml`).** Secrets
> (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`)
> are configured in GitHub. Do not ask for the database password — you do
> not need it.
>
> 1. Commit your changes and push to `main`. The workflow runs on push
>    for any change under `supabase/**` (or the workflow file itself).
> 2. The `verify` job runs the security audit, `deno lint`, `deno check`,
>    and the full Deno test suite (including `webauthn_test.ts`).
> 3. The `deploy` job (main only) links the project, applies pending
>    migrations with `supabase db push`, then deploys the `api` Edge
>    Function with `supabase functions deploy api --no-verify-jwt`. It also
>    ensures the `2FA_CHALLENGE_SIGNING_KEY` Edge Function secret exists
>    (created once with a random value if missing — never rotated).
> 4. Watch the run: `gh run watch --branch main` or the GitHub UI.
>
> Local dry-run equivalents (no deployment):
> ```bash
> cd supabase/functions/api
> deno lint . && deno check index.ts
> deno test --allow-env --allow-net auth_test.ts jwt_test.ts metadata_test.ts playback_test.ts two_factor_test.ts webauthn_test.ts auth_matrix_test.ts contracts_test.ts
> ```

# Deployment Guide: RLS Policies

This guide covers the deployment of Row Level Security (RLS) policies for the audiobookphile backend database schema. It includes step-by-step instructions, testing procedures, and rollback procedures.

## Prerequisites

### 1. Environment Setup

- **Docker** - For running Supabase locally (if not using managed Supabase)
- **Supabase CLI** - Version 1.170.0 or later
  ```bash
  brew install supabase/tap/supabase
  ```
- **Supabase Password** - Load from attached file:
  ```bash
  cat supabase_audiobookshelf_pass
  ```

### 2. Environment Variables

Create a `.env.local` file with the following:

```env
SUPABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.iambzzclljayqdxkeepy.supabase.co:5432/postgres
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

For local development:
```env
SUPABASE_URL=http://localhost:54323
SUPABASE_ACCESS_TOKEN=your-local-token
```

### 3. Docker Setup (Optional - Local Development)

If deploying locally:

```bash
# Start Supabase stack with your configuration
supabase start

# Or use Docker Compose
docker-compose up -d
```

## Phase 1: Database Connection Verification

### 1.1 Connect to Supabase

```bash
supabase status
```

Verify connection:
- URL is accessible
- Database credentials are valid
- Service role access is configured

### 1.2 Check Current RLS Status

```sql
SELECT 
  schemaname,
  tablename,
  rowsecurity as is_rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

**Expected Output:**
- 18 tables should show `true` for `ise_rls_enabled` (if policies already applied)
- OR `false` for all tables (if this is a fresh deployment)

## Phase 2: Migration Execution

### 2.1 Backup Current State

**CRITICAL** - Always backup before applying RLS changes:

```bash
# Create backup
supabase db dump --schema-only > backup_pre_rls_policies.sql

# Or full backup
supabase db dump > backup_pre_rls_policies_full.sql
```

### 2.2 Apply Migration

```bash
# Apply the RLS migration
supabase migration run --from 20240001000000 --to 20260725000000

# Or directly from the migration file
supabase db push
```

### 2.3 Verify RLS Configuration

Run the following SQL to verify RLS is properly configured:

```sql
-- Check RLS status for all 18 tables
SELECT 
  schemaname,
  tablename,
  rowsecurity,
  array_length(relacl, 1) as acl_length
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Expected: All 18 tables should have rowsecurity = true
```

### 2.4 Verify Policy Names

```sql
-- List all policies
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  cmd
FROM pg_policies
ORDER BY tablename, policyname;
```

**Verify:**
- 53 policies created (6 per table × 18 tables - but bookmarks, media_progress, search_history have 3 policies each = 54 total, minus 1 admin policy = 53)
- Policy naming convention: `<table_name>: <user_type> can <verb> <target>`
- All policies have proper `USING` and `WITH CHECK` expressions

### 2.5 Verify Helper Functions

```sql
-- List all functions
SELECT 
  schemaname,
  routine_name,
  routine_type,
  is_security_definer
FROM information_schema.routines
WHERE routine_name IN (
  'is_owner_of_library',
  'is_member_of_library',
  'has_library_access',
  'is_admin',
  'is_authenticated',
  'has_role'
);
```

**Expected Output:**
- 6 helper functions created
- All functions have `is_security_definer = true`

### 2.6 Verify Service Role Grants

```sql
-- Check service role grants
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'service_role'
  AND table_schema = 'public';
```

**Expected:**
- service_role should have ALL privileges on ALL tables
- service_role should have USAGE on ALL sequences
- service_role should have EXECUTE on ALL functions

## Phase 3: Testing Procedures

### 3.1 Authentication Testing

You must have authenticated users to test RLS policies. Use the Supabase CLI or Postman to authenticate:

```bash
# Using Supabase CLI
supabase login
```

Or create test accounts in your application.

### 3.2 Per-Table Testing Checklist

**Table: libraries**
- [ ] Users can READ their own libraries (`libraries: users can read own library`)
- [ ] Users can READ other members' libraries (`libraries: members can read members' libraries`)
- [ ] Users can INSERT their own libraries (`libraries: authenticated users can insert own library`)
- [ ] Users can UPDATE their own libraries (`libraries: authenticated users can update own library`)
- [ ] Users can DELETE their own libraries (`libraries: authenticated users can delete own library`)
- [ ] Admins can perform all operations on libraries (`libraries: admins can manage all libraries`)

**Table: authors**
- [ ] Users can READ all authors (`authors: users can read all`)
- [ ] Admins can create/update/delete authors (`authors: admins can manage all authors`)

**Table: narrators**
- [ ] Users can READ all narrators (`narrators: users can read all`)
- [ ] Admins can create/update/delete narrators (`narrators: admins can manage all narrators`)

**Table: series**
- [ ] Users can READ all series (`series: users can read all`)
- [ ] Admins can create/update/delete series (`series: admins can manage all series`)

**Table: playlists**
- [ ] Users can READ their own playlists (`playlists: users can read own playlist`)
- [ ] Users can INSERT their own playlists (`playlists: authenticated users can insert own playlist`)
- [ ] Users can UPDATE their own playlists (`playlists: authenticated users can update own playlist`)
- [ ] Users can DELETE their own playlists (`playlists: authenticated users can delete own playlist`)
- [ ] Admins can manage all playlists (`playlists: admins can manage all playlists`)

**Table: book_authors**
- [ ] Users can READ accessible book authors (`book_authors: users can read accessible book authors`)
- [ ] Users can UPDATE accessible book authors (`book_authors: users can update accessible book authors`)
- [ ] Admins can create/book_authors (`book_authors: admins can create book authors`)

**Table: book_narrators**
- [ ] Users can READ accessible book narrators (`book_narrators: users can read accessible book narrators`)
- [ ] Users can UPDATE accessible book narrators (`book_narrators: users can update accessible book narrators`)
- [ ] Admins can create/book_narrators (`book_narrators: admins can create book narrators`)

**Table: book_series**
- [ ] Users can READ accessible book series (`book_series: users can read accessible book series`)
- [ ] Users can UPDATE accessible book series (`book_series: users can update accessible book series`)
- [ ] Admins can create/book_series (`book_series: admins can create book series`)

**Table: audio_files**
- [ ] Users can READ accessible audio files (`audio_files: users can read accessible audio files`)
- [ ] Users can UPDATE accessible audio files (`audio_files: users can update accessible audio files`)
- [ ] Admins can create/audio_files (`audio_files: admins can create audio files`)

**Table: chapters**
- [ ] Users can READ accessible chapters (`chapters: users can read accessible chapters`)
- [ ] Users can UPDATE accessible chapters (`chapters: users can update accessible chapters`)
- [ ] Admins can create/chapters (`chapters: admins can create chapters`)

**Table: podcast_episodes**
- [ ] Users can READ accessible podcast episodes (`podcast_episodes: users can read accessible podcast episodes`)
- [ ] Users can UPDATE accessible podcast episodes (`podcast_episodes: users can update accessible podcast episodes`)
- [ ] Admins can create/podcast_episodes (`podcast_episodes: admins can create podcast episodes`)

**Table: media_progress**
- [ ] Users can READ their own progress (`media_progress: users can read own progress`)
- [ ] Users can INSERT their own progress (`media_progress: authenticated users can insert own progress`)
- [ ] Users can UPDATE their own progress (`media_progress: authenticated users can update own progress`)
- [ ] Users can DELETE their own progress (`media_progress: authenticated users can delete own progress`)

**Table: playlist_items**
- [ ] Users can READ accessible playlist items (`playlist_items: users can read accessible playlist items`)
- [ ] Users can UPDATE accessible playlist items (`playlist_items: users can update accessible playlist items`)
- [ ] Admins can create/playlist_items (`playlist_items: admins can create playlist items`)

**Table: collections**
- [ ] Users can READ their own collections (`collections: users can read own collection`)
- [ ] Users can INSERT their own collections (`collections: authenticated users can insert own collection`)
- [ ] Users can UPDATE their own collections (`collections: authenticated users can update own collection`)
- [ ] Users can DELETE their own collections (`collections: authenticated users can delete own collection`)
- [ ] Admins can manage all collections (`collections: admins can manage all collections`)

**Table: collection_items**
- [ ] Users can READ accessible collection items (`collection_items: users can read accessible collection items`)
- [ ] Users can UPDATE accessible collection items (`collection_items: users can update accessible collection items`)
- [ ] Admins can create/collection_items (`collection_items: admins can create collection items`)

**Table: bookmarks**
- [ ] Users can READ their own bookmarks (`bookmarks: users can read own bookmarks`)
- [ ] Users can INSERT their own bookmarks (`bookmarks: authenticated users can insert own bookmarks`)
- [ ] Users can UPDATE their own bookmarks (`bookmarks: authenticated users can update own bookmarks`)
- [ ] Users can DELETE their own bookmarks (`bookmarks: authenticated users can delete own bookmarks`)

**Table: search_history**
- [ ] Users can READ their own search history (`search_history: users can read own search history`)
- [ ] Users can INSERT their own search history (`search_history: authenticated users can insert own search history`)
- [ ] Users can DELETE their own search history (`search_history: authenticated users can delete own search history`)

### 3.3 Test with Supabase CLI

```bash
# Test a specific table for user X
supabase db exec "
SELECT * FROM libraries 
WHERE library_id = '<library_id>' 
  AND auth.uid() = <user_x>;
"

# Expected: Returns user's own library
```

### 3.4 Test Library Access

```sql
-- Test library ownership check
SELECT * FROM libraries WHERE library_id = '<library_id>';
```

**Expected:**
- User X can see their own library
- Member of library can see it
- Other users cannot see it

### 3.5 Test Admin Privileges

```sql
-- Test admin access (using service_role or admin authenticated user)
SET ROLE service_role;

SELECT * FROM libraries;
-- Should return all libraries

SELECT * FROM authors;
-- Should return all authors

-- Reset role
RESET ROLE;
```

## Phase 4: Troubleshooting

### 4.1 RLS Prevents Query

**Symptom:** Queries fail with `permission denied for table`

**Solution:**
```sql
-- Check if RLS is enabled
SELECT rowsecurity FROM pg_tables WHERE tablename = 'libraries';

-- If false, enable it
ALTER TABLE libraries ENABLE ROW LEVEL SECURITY;
```

### 4.2 Policy Missing

**Symptom:** Query succeeds when it shouldn't

**Solution:**
```sql
-- Drop and recreate policy
DROP POLICY IF EXISTS "libraries: users can read own library" ON libraries;
CREATE POLICY "libraries: users can read own library"
ON libraries
USING (auth.uid() = library_owner_id OR library_owner_id IN (
  SELECT user_id FROM library_members WHERE library_id = libraries.id
))
WITH CHECK (auth.uid() = library_owner_id OR library_owner_id IN (
  SELECT user_id FROM library_members WHERE library_id = libraries.id
));
```

### 4.3 Function Permission Denied

**Symptom:** Helper functions fail with permission denied

**Solution:**
```sql
-- Ensure functions use SECURITY DEFINER
ALTER FUNCTION is_owner_of_library(UUID) SET SECURITY DEFINER;
ALTER FUNCTION is_member_of_library(UUID) SET SECURITY DEFINER;
ALTER FUNCTION has_library_access(UUID) SET SECURITY DEFINER;
ALTER FUNCTION is_admin() SET SECURITY DEFINER;
ALTER FUNCTION is_authenticated() SET SECURITY DEFINER;
ALTER FUNCTION has_role(TEXT) SET SECURITY DEFINER;
```

### 4.4 Service Role Missing

**Symptom:** External APIs or admin operations fail

**Solution:**
```sql
-- Grant service role access to all objects
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Create service role if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolename = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END $$;
```

### 4.5 Policy Conflicts

**Symptom:** Some operations work, others fail

**Solution:**
```sql
-- List all policies for a specific table
SELECT * FROM pg_policies WHERE tablename = 'library_items';

-- Check if conflicting policies exist
DROP POLICY IF EXISTS "conflicting_policy_name" ON library_items;
```

### 4.6 Debug Using pg_log

```sql
-- Enable detailed logging
SET log_statement = 'all';
SET log_min_duration_statement = 1000;

-- Run problematic query
SELECT * FROM libraries WHERE ...;

-- Check logs
SELECT * FROM pg_log WHERE ts > NOW() - INTERVAL '5 minutes';
```

## Phase 5: Type Regeneration

### 5.1 Run Type Generation

```bash
# Install Supabase CLI if not already installed
npm install -g @supabase/cli

# Generate TypeScript types
cd audiobookphile-backend
supabase gen types typescript --db > ../audiobookphile-web/src/types/database.ts
```

### 5.2 Review Generated Types

**Check for:**
- All 18 tables are exported
- All columns have correct types
- All enum values are present
- RLS-related helper functions are included

### 5.3 Sync Types to Frontend

**audiobookphile-web:**

```bash
# Copy types to web project
cp audiobookphile-backend/types/output/types.ts audiobookphile-web/src/types/database.ts

# Or use Supabase project sync
supabase gen types typescript --project-ref <your-project-ref> --lang=typescript --local
```

**Verify frontend types:**
```bash
cd audiobookphile-web
npm run typecheck
```

### 5.4 Backend Type Updates

**audiobookphile-backend:**

```bash
# Generate backend types
supabase gen types typescript --project-ref <your-project-ref> --lang=typescript
```

**Review and update:**
- `src/types/database.ts`
- `src/types/index.ts` (exported types)
- Any types that depend on schema changes

### 5.5 Run Type Checks

```bash
# Backend type check
npm run typecheck

# Frontend type check
npm run typecheck

# Both should pass without errors
```

## Phase 6: Rollback Procedures

### 6.1 Rollback RLS Policies

```bash
# Restore from backup
supabase db restore < backup_pre_rls_policies_full.sql

# Or use migration rollback
supabase migration rollback --to 20240001000000
```

### 6.2 Verify Rollback

```sql
SELECT 
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public';

-- Expected: All tables should have rowsecurity = false (or original state)
```

### 6.3 Revert Type Changes

**If types were regenerated and causing issues:**

```bash
# Revert to previous version in git
git checkout HEAD~N -- audiobookphile-web/src/types/database.ts
git checkout HEAD~N -- audiobookphile-backend/src/types/database.ts

# Restore from backup if needed
git restore audiobookphile-web/src/types/database.ts
git restore audiobookphile-backend/src/types/database.ts
```

### 6.4 Rollback Database Schema

```bash
# Full rollback
supabase db restore < pre_migration_backup.sql

# Or specific migration rollback
supabase db reset
```

## Phase 7: Production Deployment

### 7.1 Final Pre-Deployment Checklist

- [ ] All RLS policies are correctly named
- [ ] All policies have correct USING and WITH CHECK clauses
- [ ] All helper functions use SECURITY DEFINER
- [ ] Service role has all necessary grants
- [ ] All 18 tables have RLS enabled
- [ ] Type generation is complete
- [ ] All test cases pass
- [ ] No permission denied errors
- [ ] Admin operations work correctly
- [ ] External API operations work with service role

### 7.2 Deploy to Production

```bash
# Pull latest changes
supabase status
git pull origin main

# Run database migrations
supabase migration run

# Deploy functions
supabase functions deploy

# Verify deployment
supabase status
```

### 7.3 Post-Deployment Verification

```bash
# Connect to production
supabase status

# Run production tests
npm run test:e2e  # or your E2E test suite

# Verify all tables have RLS enabled
supabase db exec "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"

# Test key user flows:
# - User can access own library
# - User can read accessible content
# - Admin can manage all content
```

### 7.4 Monitor for Issues

**Set up monitoring for:**
- RLS-related errors in application logs
- Performance degradation after RLS enforcement
- Unusual access patterns

```sql
-- Check RLS-related errors
SELECT 
  error,
  count
FROM pg_stat_statements
WHERE query LIKE '%RLS%' OR query LIKE '%auth.uid()%'
GROUP BY error
ORDER BY count DESC;
```

## Phase 8: Maintenance

### 8.1 Adding New Tables

When adding new tables:
1. Add RLS enablement in migration:
   ```sql
   ALTER TABLE <new_table> ENABLE ROW LEVEL SECURITY;
   ```

2. Add at least one policy:
   ```sql
   CREATE POLICY "authenticated_users_can_read_own_<table>"
   ON <new_table>
   USING (auth.uid() = <user_column>)
   WITH CHECK (auth.uid() = <user_column>);
   ```

3. Generate new types:
   ```bash
   supabase gen types typescript
   ```

### 8.2 Updating Existing Policies

When updating a policy:
1. Drop the old policy:
   ```sql
   DROP POLICY IF EXISTS "old_policy_name" ON <table>;
   ```

2. Create new policy:
   ```sql
   CREATE POLICY "new_policy_name"
   ON <table>
   USING (<new_conditions>)
   WITH CHECK (<new_check_conditions>);
   ```

3. Regenerate types:
   ```bash
   supabase gen types typescript
   ```

### 8.3 Periodic Audits

**Monthly:**
- Check for any RLS-related errors in logs
- Review access patterns
- Verify policy effectiveness

**Quarterly:**
- Review all RLS policies for effectiveness
- Test all user access patterns
- Update policies based on usage changes

## Appendix: Quick Reference

### Policy Syntax Reference

```sql
-- Basic permissive policy
CREATE POLICY "users can read own <table>"
ON <table>
USING (auth.uid() = <user_column>)
WITH CHECK (auth.uid() = <user_column>);

-- Admin-only policy
CREATE POLICY "admins can manage all <table>"
ON <table>
USING (is_admin())
WITH CHECK (is_admin());

-- Public read policy
CREATE POLICY "users can read all <table>"
ON <table>
USING (true)
WITH CHECK (true);
```

### Helper Function Reference

```sql
-- Check library ownership
CREATE OR REPLACE FUNCTION is_owner_of_library(p_library_id UUID)
RETURNS BOOLEAN SECURITY DEFINER
LANGUAGE SQL
AS $$
SELECT EXISTS (
  SELECT 1 FROM libraries WHERE id = p_library_id AND owner_id = auth.uid()
);
$$;

-- Check library membership
CREATE OR REPLACE FUNCTION is_member_of_library(p_library_id UUID)
RETURNS BOOLEAN SECURITY DEFINER
LANGUAGE SQL
AS $$
SELECT EXISTS (
  SELECT 1 FROM library_members 
  WHERE library_id = p_library_id AND user_id = auth.uid()
);
$$;

-- Check combined library access
CREATE OR REPLACE FUNCTION has_library_access(p_library_id UUID)
RETURNS BOOLEAN SECURITY DEFINER
LANGUAGE SQL
AS $$
SELECT is_owner_of_library(p_library_id) OR is_member_of_library(p_library_id);
$$;

-- Check if user is admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN SECURITY DEFINER
LANGUAGE SQL
AS $$
SELECT EXISTS (
  SELECT 1 FROM users WHERE is_admin = true AND id = auth.uid()
);
$$;

-- Check if user is authenticated
CREATE OR REPLACE FUNCTION is_authenticated()
RETURNS BOOLEAN SECURITY DEFINER
LANGUAGE SQL
AS $$
SELECT auth.jwt() IS NOT NULL;
$$;

-- Check for specific role
CREATE OR REPLACE FUNCTION has_role(p_role_name TEXT)
RETURNS BOOLEAN SECURITY DEFINER
LANGUAGE SQL
AS $$
SELECT EXISTS (
  SELECT 1 FROM user_roles 
  WHERE role_name = p_role_name AND user_id = auth.uid()
);
$$;
```

### Emergency Rollback Commands

```bash
# Immediate rollback of all RLS changes
supabase db reset

# Restore from specific backup
supabase db restore <backup_file.sql>

# Disable RLS on all tables
supabase db exec "
ALTER TABLE libraries DISABLE ROW LEVEL SECURITY;
ALTER TABLE authors DISABLE ROW LEVEL SECURITY;
ALTER TABLE narrators DISABLE ROW LEVEL SECURITY;
-- ... for all 18 tables
"
```

---

*Last updated: 2026-07-25*