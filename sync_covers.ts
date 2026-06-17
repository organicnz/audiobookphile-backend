import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.2";
import { fetchBookMetadata } from "./supabase/functions/_shared/coverFetch.ts";
import "https://deno.land/std@0.208.0/dotenv/load.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function sync() {
  const { data: items, error } = await supabase
    .from("library_items")
    .select("id, cover_path, books(title, book_authors(authors(name)))");

  if (error) {
    console.error("Error fetching items:", error);
    return;
  }

  for (const item of items) {
    if (
      !item.cover_path || item.cover_path === "missing" ||
      item.cover_path.startsWith("/")
    ) {
      const book = Array.isArray(item.books) ? item.books[0] : item.books;
      if (!book) continue;

      const title = book.title;
      const authors = book.book_authors || [];
      const authorList = Array.isArray(authors) ? authors : [authors];
      const authorName = authorList[0]?.authors?.name || "";

      console.log(`Fetching cover for: ${title} - ${authorName}`);

      try {
        const res = await fetchBookMetadata(title, authorName);
        if (res.cover) {
          const fileData = new Uint8Array(res.cover.buffer);
          const ext = res.cover.extension || "jpg";
          const coverPath = `${item.id}/cover.${ext}`;
          const contentType = `image/${ext === "png" ? "png" : "jpeg"}`;

          console.log(`Uploading ${coverPath}...`);
          const { error: uploadError } = await supabase.storage.from("covers")
            .upload(
              coverPath,
              fileData,
              { upsert: true, contentType },
            );

          if (uploadError) {
            console.error(`Upload error for ${title}:`, uploadError);
            continue;
          }

          const { error: updateError } = await supabase.from("library_items")
            .update({
              cover_path: coverPath,
            }).eq("id", item.id);

          if (updateError) {
            console.error(`Update error for ${title}:`, updateError);
          } else {
            console.log(`Successfully updated ${title}`);
          }
        } else {
          console.log(`No cover found for ${title}. Marking as missing.`);
          await supabase.from("library_items").update({ cover_path: "missing" })
            .eq("id", item.id);
        }
      } catch (err) {
        console.error(`Failed to fetch for ${title}:`, err);
      }

      // Delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

sync();
