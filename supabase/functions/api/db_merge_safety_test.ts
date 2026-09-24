// L2 integration tests for the library dedupe safety pipeline (migrations
// 20260825180000 + 20260825190000).
//
// These run REAL SQL against the linked project inside a transaction that is
// always rolled back - fixtures never persist. The migration DDL itself is
// applied inside the same transaction, making the suite hermetic: it passes
// identically before (validating) and after (confirming) a deploy.
//
// Skips unless SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_ID are present, so
// local unit runs and CI's unprivileged verify stage stay green.
const ACCESS_TOKEN = Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? "";
const PROJECT_ID = Deno.env.get("SUPABASE_PROJECT_ID") ?? "";

const MIG_1 = new URL(
  "../../migrations/20260825180000_dedupe_guard_and_deletion_audit.sql",
  import.meta.url,
);
const MIG_2 = new URL(
  "../../migrations/20260825190000_merge_safety_redesign.sql",
  import.meta.url,
);
const MIG_3 = new URL(
  "../../migrations/20260826120000_merge_overload_disambig.sql",
  import.meta.url,
);
const MIG_4 = new URL(
  "../../migrations/20260924064104_harden_library_item_deletion.sql",
  import.meta.url,
);
const MIG_5 = new URL(
  "../../migrations/20260924153656_harden_item_delete_retry.sql",
  import.meta.url,
);

async function execSql(query: string): Promise<string> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${text.slice(0, 500)}`);
  return text;
}

const shouldRun = ACCESS_TOKEN.length > 0 && PROJECT_ID.length > 0;

Deno.test({
  name:
    "db merge-safety: planner/dry-run/guard/audits hold on fixture duplicates",
  ignore: !shouldRun,
  fn: async () => {
    const mig1 = await Deno.readTextFile(MIG_1);
    const mig2 = await Deno.readTextFile(MIG_2);
    const mig3 = await Deno.readTextFile(MIG_3);
    const LIB = crypto.randomUUID();
    const OLD_ID = crypto.randomUUID();
    const NEW_ID = crypto.randomUUID();
    const USER = "74b80bba-63af-476f-9faa-8e3dff48cc51"; // any extant user id

    const sql = `
BEGIN;
${mig1}
${mig2}
${mig3}

INSERT INTO public.libraries (id, name) VALUES ('${LIB}', 'merge-test-lib');
INSERT INTO public.library_items (id, title, library_id, created_at, duration, audio_files, author_names_first_last)
VALUES
 ('${OLD_ID}', 'Test Merge Target Alpha', '${LIB}', now() - interval '30 days', 1000,
  '[{"metadata":{"filename":"alpha specific long filename part A.mp3","path":"/x/a.mp3"}},
    {"metadata":{"filename":"alpha specific long filename part B.mp3","path":"/x/b.mp3"}}]'::jsonb, 'Unknown Author'),
 ('${NEW_ID}', 'Alpha (test merge)', '${LIB}', now(), 800,
  '[{"metadata":{"filename":"alpha specific long filename part B.mp3","path":"/y/b.mp3"}},
    {"metadata":{"filename":"newer exclusive track file here.mp3","path":"/y/c.mp3"}}]'::jsonb, 'Jane Coder');
INSERT INTO public.media_progress (user_id, library_item_id, duration, progress, current_time_pos)
VALUES ('${USER}', '${NEW_ID}', 800, 0.5, 400);

DO $test$
DECLARE
  v_plan RECORD; v_n int; v_flag text; v_it RECORD;
BEGIN
  -- Guard disabled => no-op even when explicitly false
  SELECT value::text INTO v_flag FROM public.server_settings WHERE key='auto_dedupe_enabled';
  IF COALESCE(v_flag,'') IN ('true','"true"') THEN
    RAISE EXCEPTION 'A0 FAIL: flag must default to disabled';
  END IF;
  UPDATE public.server_settings SET value='false' WHERE key='auto_dedupe_enabled';
  v_n := public.deduplicate_library_items_guarded();
  IF v_n <> 0 THEN RAISE EXCEPTION 'A0 FAIL: guarded ran while disabled'; END IF;

  -- Planner pairs duplicates, oldest row is primary
  SELECT * INTO v_plan FROM public.plan_library_item_merges()
   WHERE primary_id='${OLD_ID}' AND dup_id='${NEW_ID}';
  IF NOT FOUND THEN RAISE EXCEPTION 'A1 FAIL: plan missing or wrong primary'; END IF;

  -- Dry-run reports work but mutates nothing
  v_n := public.deduplicate_library_items(true);
  IF v_n < 1 THEN RAISE EXCEPTION 'A2 FAIL: dry count %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.library_items WHERE library_id='${LIB}';
  IF v_n <> 2 THEN RAISE EXCEPTION 'A2 FAIL: dry run mutated rows'; END IF;

  -- Guard executes when enabled
  UPDATE public.server_settings SET value='true' WHERE key='auto_dedupe_enabled';
  v_n := public.deduplicate_library_items_guarded();
  IF v_n < 1 THEN RAISE EXCEPTION 'A3 FAIL: merged count %', v_n; END IF;

  -- Survivor is the oldest id, union of unique files, duration = max (no double-count)
  SELECT id, jsonb_array_length(audio_files) AS afn, duration INTO v_it
  FROM public.library_items WHERE library_id='${LIB}';
  IF v_it.id <> '${OLD_ID}' THEN RAISE EXCEPTION 'A4 FAIL: survivor %', v_it.id; END IF;
  IF v_it.afn <> 3 THEN RAISE EXCEPTION 'A4 FAIL: audio count %', v_it.afn; END IF;
  IF v_it.duration <> 1000 THEN RAISE EXCEPTION 'A4 FAIL: duration % (double-count regression)', v_it.duration; END IF;

  -- FKs migrated to survivor
  SELECT count(*) INTO v_n FROM public.media_progress
   WHERE user_id='${USER}' AND library_item_id='${OLD_ID}';
  IF v_n <> 1 THEN RAISE EXCEPTION 'A5 FAIL: progress not moved'; END IF;

  -- Merge audit + deletion audit both captured the operation
  SELECT count(*) INTO v_n FROM public.library_item_merge_audit
   WHERE dup_id='${NEW_ID}' AND primary_id='${OLD_ID}';
  IF v_n <> 1 THEN RAISE EXCEPTION 'A6 FAIL: merge audit missing'; END IF;
  SELECT count(*) INTO v_n FROM public.library_item_deletion_audit WHERE item_id='${NEW_ID}';
  IF v_n < 1 THEN RAISE EXCEPTION 'A6 FAIL: deletion audit missing'; END IF;
END $test$;

SELECT 'DB-MERGE-SAFETY-OK' AS status;
ROLLBACK;
`;

    const out = await execSql(sql);
    if (!out.includes("DB-MERGE-SAFETY-OK")) {
      throw new Error(
        `invariant assertions did not complete: ${out.slice(0, 500)}`,
      );
    }
  },
});

Deno.test({
  name:
    "db item-delete: authorization, atomic manifest, and pending retry are durable",
  ignore: !shouldRun,
  fn: async () => {
    const mig1 = await Deno.readTextFile(MIG_1);
    const mig2 = await Deno.readTextFile(MIG_2);
    const mig3 = await Deno.readTextFile(MIG_3);
    const mig4 = await Deno.readTextFile(MIG_4);
    const mig5 = await Deno.readTextFile(MIG_5);
    const libraryId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const retryItemId = crypto.randomUUID();

    const sql = `
BEGIN;
${mig1}
${mig2}
${mig3}
${mig4}
${mig5}

INSERT INTO public.libraries (id, name)
VALUES ('${libraryId}', 'item-delete-test-lib');
INSERT INTO public.library_items
  (id, title, library_id, audio_files, cover_path)
VALUES
  ('${itemId}', 'Atomic delete target', '${libraryId}',
   '[{"metadata":{"relPath":"${itemId}/track-01.mp3"}},
     null]'::jsonb,
   '${itemId}/cover.jpg'),
  ('${retryItemId}', 'Pending retry target', '${libraryId}',
   '[{"metadata":{"relPath":"${retryItemId}/track-01.mp3"}}]'::jsonb,
   'missing');

DO $test$
DECLARE
  v_admin uuid;
  v_bad_actor uuid := 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  v_result jsonb;
  v_audit_id bigint;
  v_status text;
  v_mode text;
  v_actor uuid;
  v_unresolved integer;
BEGIN
  SELECT id INTO v_admin
  FROM public.profiles
  WHERE user_type IN ('admin', 'root')
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'D0 FAIL: no admin profile available';
  END IF;

  BEGIN
    PERFORM public.delete_library_item_atomic('${itemId}', true, v_bad_actor);
    RAISE EXCEPTION 'D1 FAIL: unknown actor was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.library_items WHERE id = '${itemId}') THEN
    RAISE EXCEPTION 'D1 FAIL: unauthorized delete removed item';
  END IF;

  v_result := public.delete_library_item_atomic('${itemId}', false, v_admin);
  IF v_result->>'found' IS DISTINCT FROM 'true'
     OR v_result->>'retry' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'D2 FAIL: database delete response was malformed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.library_items WHERE id = '${itemId}') THEN
    RAISE EXCEPTION 'D2 FAIL: item row remains';
  END IF;

  SELECT id, delete_mode, storage_cleanup_status, deleted_by_user_id,
         (storage_manifest->>'unresolvedStorageCount')::integer
  INTO v_audit_id, v_mode, v_status, v_actor, v_unresolved
  FROM public.library_item_deletion_audit
  WHERE item_id = '${itemId}'
  ORDER BY id DESC LIMIT 1;
  IF v_audit_id IS NULL OR v_mode IS DISTINCT FROM 'database'
     OR v_status IS DISTINCT FROM 'not_requested'
     OR v_actor IS DISTINCT FROM v_admin OR v_unresolved IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'D2 FAIL: deletion audit is incomplete';
  END IF;

  v_result := public.delete_library_item_atomic('${retryItemId}', true, v_admin);
  IF v_result->>'found' IS DISTINCT FROM 'true'
     OR v_result->>'retry' IS DISTINCT FROM 'false'
     OR v_result->>'storage_cleanup_status' IS DISTINCT FROM 'pending'
     OR v_result->'manifest'->>'manifestVersion' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'D3 FAIL: initial hard delete response was malformed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.library_items WHERE id = '${retryItemId}') THEN
    RAISE EXCEPTION 'D3 FAIL: hard delete item remains';
  END IF;

  v_result := public.delete_library_item_atomic('${retryItemId}', true, v_admin);
  IF v_result->>'found' IS DISTINCT FROM 'true'
     OR v_result->>'retry' IS DISTINCT FROM 'true'
     OR v_result->>'storage_cleanup_status' IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'D4 FAIL: pending cleanup was not retryable';
  END IF;
  v_audit_id := (v_result->>'audit_id')::bigint;
  IF v_audit_id IS NULL THEN
    RAISE EXCEPTION 'D4 FAIL: retry has no audit id';
  END IF;

  PERFORM public.record_library_item_storage_cleanup(
    v_audit_id, 'pending', 'fixture retry', 0, 1
  );
  PERFORM public.record_library_item_storage_cleanup(
    v_audit_id, 'complete', '', 1, 0
  );
  SELECT storage_files_retained
  INTO v_unresolved
  FROM public.library_item_deletion_audit
  WHERE id = v_audit_id;
  IF v_unresolved IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'D5 FAIL: completed cleanup retained files';
  END IF;

  v_result := public.delete_library_item_atomic('${retryItemId}', true, v_admin);
  IF v_result->>'found' IS DISTINCT FROM 'true'
     OR v_result->>'retry' IS DISTINCT FROM 'false'
     OR v_result->>'storage_cleanup_status' IS DISTINCT FROM 'complete'
     OR (v_result->>'storage_files_retained')::integer <> 0 THEN
    RAISE EXCEPTION 'D6 FAIL: completed cleanup was not idempotent';
  END IF;

  BEGIN
    PERFORM public.record_library_item_storage_cleanup(
      v_audit_id, 'pending', 'late writer', 0, 1
    );
    RAISE EXCEPTION 'D5 FAIL: completed cleanup regressed';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END $test$;

SELECT 'DB-ITEM-DELETE-OK' AS status;
ROLLBACK;
`;

    const out = await execSql(sql);
    if (!out.includes("DB-ITEM-DELETE-OK")) {
      throw new Error(
        `item delete assertions did not complete: ${out.slice(0, 500)}`,
      );
    }
  },
});
