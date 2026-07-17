const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({
  path:
    "/Users/organic/dev/work/audiobookphile/audiobookphile-backend/supabase/.env",
});

const supabase = createClient(
  process.env.SUPABASE_URL || "http://127.0.0.1:54321",
  process.env.SUPABASE_ANON_KEY || "ey...", // Need the actual local anon key if testing locally
);

async function run() {
  const { data, error } = await supabase
    .from("media_progress")
    .select("*, library_items(library_id)")
    .limit(100);
  console.log("Error:", error);
  console.log("Data count:", data?.length);
  if (data) {
    const counts = data.reduce((acc, row) => {
      const isFinished = row.is_finished;
      acc[isFinished] = (acc[isFinished] || 0) + 1;
      return acc;
    }, {});
    console.log("Finished counts:", counts);
  }
}
run();
