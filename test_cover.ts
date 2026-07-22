import { fetchBookMetadata } from "./supabase/functions/_shared/coverFetch.ts";

async function test() {
  console.log("Fetching...");
  const res = await fetchBookMetadata("The Martian", "Andy Weir");
  console.log(res?.cover ? "Found cover" : "No cover");
}
test();
