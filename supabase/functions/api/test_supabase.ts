import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Using the local environment variables or standard defaults
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "http://127.0.0.1:54321";
const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") || "dummy";

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data, error: _error } = await supabase
    .from("series")
    .select("*, book_series(book_id, sequence, books(id, title, cover_path))")
    .limit(1);

  console.log(JSON.stringify(data, null, 2));
}

test();
