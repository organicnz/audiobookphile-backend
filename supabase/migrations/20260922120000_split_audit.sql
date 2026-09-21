-- Forensic audit trail for autonomous library_item splits.
-- split_merged_books.ts keeps the largest folder group in place (stable id)
-- and inserts sibling items for the other groups; every created sibling is
-- recorded here so any split can be reviewed or manually reverted.
CREATE TABLE IF NOT EXISTS public.library_item_split_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_item_id uuid NOT NULL,
  created_item_id uuid NOT NULL,
  folder text NOT NULL DEFAULT '',
  track_count integer NOT NULL DEFAULT 0,
  decided_by text NOT NULL DEFAULT 'deterministic',
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.library_item_split_audit FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS library_item_split_audit_source_idx
  ON public.library_item_split_audit (source_item_id);
