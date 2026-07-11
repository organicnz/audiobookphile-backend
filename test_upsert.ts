import { createClient } from "npm:@supabase/supabase-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://127.0.0.1:54321";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || process.env.SUPABASE_SERVICE_ROLE_KEY;
// If testing locally, I can just use the local supabase config?
// Wait, I don't know the local keys. Let's look at .env if it exists.
