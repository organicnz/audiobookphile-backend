import { createClient, QueryData } from "npm:@supabase/supabase-js@2.44.0";
import { Database } from "../audiobookphile-web/src/types/supabase.ts";

const supabase = createClient<Database>("", "");

const itemsQuery = supabase
  .from("library_items")
  .select("*, books(*, book_authors(authors(*)), book_series(series(*)))");

type ItemsWithBooks = QueryData<typeof itemsQuery>;

const librariesQuery = supabase
  .from("libraries")
  .select("*, library_folders(*)");

type LibrariesWithFolders = QueryData<typeof librariesQuery>;
