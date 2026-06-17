import { fetchBookMetadata } from "./supabase/functions/_shared/coverFetch.ts";

async function run() {
  const res = await fetchBookMetadata("Christopher Hitchens - Mortality");
  console.log(res.metadata);
  if (res.cover) {
    console.log(
      "Cover fetched!",
      res.cover.extension,
      res.cover.buffer.byteLength,
    );
  } else {
    console.log("No cover.");
  }
}

run();
