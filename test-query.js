const path = require("path");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({
  path: process.env.ENV_PATH || path.resolve(__dirname, "supabase/.env"),
});

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
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
