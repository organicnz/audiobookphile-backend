import { serve } from "std/http/server.ts";
import { createClient } from "@supabase/supabase-js@2";
import { Database } from "../../src/types/supabase.ts";

serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Auth client with service role key to bypass RLS
    const supabase = createClient<Database>(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Verify user is an admin or the request comes from cron with service key
    const isCron = authHeader.replace("Bearer ", "") === supabaseServiceKey;

    if (!isCron) {
      // Check if user is admin
      const { data: { user }, error: userError } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", ""),
      );
      if (userError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        });
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("user_type")
        .eq("id", user.id)
        .single();

      if (!profile || !["admin", "root"].includes(profile.user_type)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
        });
      }
    }

    console.log("Starting automated database backup...");

    // Helper to fetch all records paginated (PostgREST max_rows defaults to 1000)
    const fetchAllRecords = async (table: string) => {
      let allRecords: any[] = [];
      let from = 0;
      const limit = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from(table)
          .select("*")
          .range(from, from + limit - 1);

        if (error) throw error;
        if (!data || data.length === 0) {
          hasMore = false;
        } else {
          allRecords = allRecords.concat(data);
          from += limit;
          if (data.length < limit) {
            hasMore = false;
          }
        }
      }
      return allRecords;
    };

    // 1. Fetch library metadata (books, podcasts, authors, series)
    const libraries = await fetchAllRecords("libraries");
    const libraryItems = await fetchAllRecords("library_items");
    const mediaProgress = await fetchAllRecords("media_progress");
    const serverSettings = await fetchAllRecords("server_settings");

    const backupData = {
      timestamp: new Date().toISOString(),
      libraries,
      libraryItems,
      mediaProgress,
      serverSettings,
    };

    const backupJson = JSON.stringify(backupData, null, 2);
    const filename = `backup-${new Date().toISOString().split("T")[0]}.json`;

    // 2. Upload to storage
    const { data, error: uploadErr } = await supabase.storage
      .from("backups")
      .upload(filename, backupJson, {
        contentType: "application/json",
        upsert: true,
      });

    if (uploadErr) {
      console.error("Upload Error:", uploadErr);
      throw new Error(`Failed to upload backup: ${uploadErr.message}`);
    }

    console.log(`Backup completed successfully: ${filename}`);

    return new Response(
      JSON.stringify({ success: true, message: "Backup created", filename }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (e: unknown) {
    const err = e as Error;
    console.error("Backup failed:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
