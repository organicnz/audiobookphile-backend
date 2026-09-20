-- Drop both conflicting overloads to fix PostgREST PGRST203 ambiguity
DROP FUNCTION IF EXISTS public.merge_authors(text, text, uuid);
DROP FUNCTION IF EXISTS public.merge_authors(uuid, text, text);

CREATE OR REPLACE FUNCTION public.merge_authors(
  p_library_id uuid,
  p_source_name text,
  p_target_name text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_source_id uuid;
  v_target_id uuid;
BEGIN
  SELECT id INTO v_source_id FROM public.authors WHERE library_id = p_library_id AND name = p_source_name;
  IF v_source_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_target_id FROM public.authors WHERE library_id = p_library_id AND name = p_target_name;
  IF v_target_id IS NULL THEN
    INSERT INTO public.authors (id, library_id, name) VALUES (gen_random_uuid(), p_library_id, p_target_name)
    RETURNING id INTO v_target_id;
  END IF;

  -- Delete overlapping book links on source before moving to avoid duplicate key violations
  DELETE FROM public.book_authors WHERE author_id = v_source_id AND library_item_id IN (
    SELECT library_item_id FROM public.book_authors WHERE author_id = v_target_id
  );

  -- Relink non-overlapping books to target
  UPDATE public.book_authors SET author_id = v_target_id WHERE author_id = v_source_id;

  -- Delete obsolete source author
  DELETE FROM public.authors WHERE id = v_source_id;
END;
$$;
