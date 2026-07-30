-- Migration: Ensure at least one root/admin user exists in profiles table
UPDATE public.profiles
SET user_type = 'root'
WHERE id = (
    SELECT id FROM public.profiles
    ORDER BY created_at ASC
    LIMIT 1
)
AND NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE user_type IN ('admin', 'root')
);
