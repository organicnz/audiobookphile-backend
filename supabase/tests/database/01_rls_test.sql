BEGIN;
SELECT plan(1);

-- Test: Public user cannot read private profiles
SELECT throws_ok(
  'SELECT * FROM public.profiles',
  'permission denied for table profiles',
  'Anonymous users should not be able to read the profiles table directly'
);

SELECT * FROM finish();
ROLLBACK;
