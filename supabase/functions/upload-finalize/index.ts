import { createClient } from "npm:@supabase/supabase-js@2.44.0";
import { corsHeaders } from "../_shared/cors.ts";
import { StorageRouter } from "../_shared/storage-router.ts";

import { parseTitleAndAuthor } from "../_shared/titleAuthorParser.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: authHeader ? { Authorization: authHeader } : {} },
    });
    const db = createClient(supabaseUrl, serviceRoleKey);

    const { data: { user } } = authHeader
      ? await supabase.auth.getUser()
      : { data: { user: null } };
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await db.from("profiles").select("user_type").eq(
      "id",
      user.id,
    ).single();
    if (
      !profile || !["admin", "root", "user"].includes(profile.user_type ?? "")
    ) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    let {
      bookId,
      title: rawTitle,
      author: rawAuthor = "",
      series = "",
      library: libraryId,
      mediaType = "book",
      files,
    } = body;

    let { cleanTitle: title, cleanAuthor: author } = parseTitleAndAuthor(
      rawTitle,
      rawAuthor,
    );

    // AI title/author extraction fallback via Z.ai GLM-4 if author is unknown or title is ambiguous
    if ((!author || author === "Unknown Author" || !title) && rawTitle) {
      const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
        Deno.env.get("ZHIPU_API_KEY") ?? "";
      if (zaiApiKey) {
        try {
          const aiRes = await fetch(
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${zaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "glm-4-flash",
                messages: [{
                  role: "user",
                  content:
                    `Extract the exact book title and author name from this filename/text: "${rawTitle}". Return ONLY a JSON object: {"title": "...", "author": "..."}`,
                }],
                temperature: 0.1,
              }),
            },
          );
          if (aiRes.ok) {
            const aiData = await aiRes.json();
            const content = aiData.choices?.[0]?.message?.content || "";
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (parsed.title) title = parsed.title;
              if (parsed.author) author = parsed.author;
            }
          }
        } catch (e: unknown) {
          const err = e as Error;
          console.error(
            "[upload-finalize] Z.ai GLM-4 fallback error:",
            err.message,
          );
        }
      }
    }

    if (!bookId || !title || !libraryId || !files?.length) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const missingFiles: string[] = [];

    const storageRouter = new StorageRouter(db);

    const fileCheckPromises = files.map(async (file: any) => {
      const exists = await storageRouter.fileExists(file.storagePath);
      return exists ? null : file.storagePath;
    });

    const checkResults = await Promise.all(fileCheckPromises);
    missingFiles.push(...checkResults.filter((r): r is string => r !== null));

    if (missingFiles.length > 0) {
      return new Response(
        JSON.stringify({ error: "Files missing in storage", missingFiles }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const totalSize = files.reduce((sum: number, f: any) => sum + f.size, 0);

    // --- SMART REBINDING & DUPLICATE PREVENTION ---
    // Search for existing book in library matching bookId, media_id, OR title/author
    let existingItem: any = null;

    // 1. Try matching directly by bookId or media_id
    const { data: itemById } = await db.from("library_items")
      .select(
        "id, media_id, size, library_files, audio_files, duration, author_names_first_last, title",
      )
      .or(`id.eq.${bookId},media_id.eq.${bookId}`)
      .eq("library_id", libraryId)
      .maybeSingle();

    if (itemById) {
      existingItem = itemById;
    } else if (title) {
      // 2. Try exact title match in same library
      const { data: itemByTitle } = await db.from("library_items")
        .select(
          "id, media_id, size, library_files, audio_files, duration, author_names_first_last, title",
        )
        .eq("library_id", libraryId)
        .ilike("title", title.trim())
        .maybeSingle();

      if (itemByTitle) {
        existingItem = itemByTitle;
      } else {
        // 3. Try normalized fuzzy match against all books in library
        const { data: allLibItems } = await db.from("library_items")
          .select(
            "id, media_id, size, library_files, audio_files, duration, author_names_first_last, title",
          )
          .eq("library_id", libraryId);

        if (allLibItems?.length) {
          const normalize = (s: string) =>
            s.toLowerCase().replace(/[^a-z0-9]/g, "");
          const normTitle = normalize(title);

          for (const item of allLibItems) {
            const normItemTitle = normalize(item.title || "");
            if (normItemTitle && normItemTitle === normTitle) {
              existingItem = item;
              break;
            }
          }
        }
      }
    }

    let libraryItemId = crypto.randomUUID();
    if (existingItem) {
      libraryItemId = existingItem.id;
      bookId = existingItem.media_id || existingItem.id;
      console.log(
        `[upload-finalize] Rebinding upload to existing book record: ${libraryItemId} ("${existingItem.title}")`,
      );
    }

    let baseIndex = 0;
    let finalAudioFiles: any[] = [];
    let currentDuration = 0;
    if (existingItem) {
      finalAudioFiles = existingItem.audio_files || [];
      baseIndex = finalAudioFiles.reduce(
        (max: number, af: any) => Math.max(max, af.index || 0),
        0,
      );
      currentDuration = existingItem.duration || 0;
    }

    const audioFilesJson = files.map((file: any, i: number) => ({
      index: baseIndex + i + 1,
      ino: crypto.randomUUID(),
      duration: 0,
      metadata: {
        filename: file.name,
        ext: "." + (file.name.split(".").pop()?.toLowerCase() ?? ""),
        path: file.storagePath,
        relPath: file.name,
        size: file.size,
        duration: 0,
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
        birthtimeMs: Date.now(),
      },
      addedAt: Date.now(),
      updatedAt: Date.now(),
      mimeType: file.type || "audio/mpeg",
    }));

    finalAudioFiles = [...finalAudioFiles, ...audioFilesJson];

    const zaiApiKey = Deno.env.get("ZAI_API_KEY") ??
      Deno.env.get("ZHIPU_API_KEY") ?? "";

    // Deduplicate files by filename so re-uploading doesn't create duplicate chapters
    const uniqueFilesMap = new Map<string, any>();
    for (const af of finalAudioFiles) {
      if (af.metadata?.filename) {
        uniqueFilesMap.set(af.metadata.filename, af);
      }
    }
    let deduplicatedFiles = Array.from(uniqueFilesMap.values());

    // --- Z.AI AI-OPTIMIZED SEQUENCE SORTING ---
    const filenames = deduplicatedFiles
      .map((af: any) => af.metadata?.filename || af.metadata?.relPath || "")
      .filter(Boolean);

    if (filenames.length > 1 && zaiApiKey) {
      try {
        const sortedFilenames = await sortFilesWithZAI(filenames, zaiApiKey);
        const filenameOrderMap = new Map<string, number>();
        sortedFilenames.forEach((name: string, index: number) =>
          filenameOrderMap.set(name, index)
        );

        deduplicatedFiles.sort((a: any, b: any) => {
          const nameA = a.metadata?.filename || a.metadata?.relPath || "";
          const nameB = b.metadata?.filename || b.metadata?.relPath || "";
          const orderA = filenameOrderMap.get(nameA) ?? 999;
          const orderB = filenameOrderMap.get(nameB) ?? 999;
          return orderA - orderB;
        });
      } catch (err) {
        console.warn("[upload-finalize] Z.AI file sorting fallback:", err);
      }
    } else {
      // Natural sort fallback
      deduplicatedFiles.sort((a: any, b: any) => {
        const nameA = a.metadata?.filename || "";
        const nameB = b.metadata?.filename || "";
        return nameA.localeCompare(nameB, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
    }

    deduplicatedFiles.forEach((af: any, idx: number) => af.index = idx + 1);

    const { error: bookError } = await db.from("library_items").update({
      audio_files: deduplicatedFiles,
      duration: currentDuration,
      title: title || existingItem?.title,
    }).eq("id", libraryItemId);

    if (bookError && !existingItem) {
      const res = await db.from("library_items").insert({
        id: libraryItemId,
        library_id: libraryId,
        media_type: mediaType,
        media_id: bookId,
        path: `${libraryId}/${title}`,
        rel_path: title,
        title,
        audio_files: deduplicatedFiles,
        duration: currentDuration,
        size: totalSize,
        is_missing: false,
        last_storage_check: new Date().toISOString(),
      });
      if (res.error) throw res.error;
    }

    const newLibraryFiles = audioFilesJson.map((af: any) => ({
      ino: af.ino,
      metadata: af.metadata,
      addedAt: af.addedAt,
      updatedAt: af.updatedAt,
      isSupplementary: false,
    }));

    let finalLibraryFiles = newLibraryFiles;
    if (existingItem) {
      const allLibFiles = [
        ...(existingItem.library_files || []),
        ...newLibraryFiles,
      ];
      const uniqueLibMap = new Map<string, any>();
      for (const lf of allLibFiles) {
        if (lf.metadata?.filename) {
          uniqueLibMap.set(lf.metadata.filename, lf);
        }
      }
      finalLibraryFiles = Array.from(uniqueLibMap.values());
    }
    const finalSize = (existingItem?.size || 0) + totalSize;

    const { error: itemError } = await db.from("library_items").update({
      size: finalSize,
      library_files: finalLibraryFiles,
      last_storage_check: new Date().toISOString(),
    }).eq("id", libraryItemId);

    if (itemError && !existingItem) {
      throw itemError;
    }

    // --- BACKGROUND TASK: Extract Audio Duration ---
    const processDurationsAsync = async () => {
      try {
        const storageRouter = new StorageRouter(db);
        let mm: any = null;
        try {
          mm = await import("npm:music-metadata@10.8.0");
        } catch (_err) {
          console.warn("[upload-finalize] Could not load music-metadata");
        }

        const metadataPromises = files.map(async (file: any, i: number) => {
          const existingAf = audioFilesJson[i];
          let duration = 0;
          try {
            const signedUrl = await storageRouter.getSignedUrl(
              file.storagePath,
              60,
            );
            if (signedUrl && mm) {
              const res = await fetch(signedUrl);
              if (res.body) {
                const metadata = await mm.parseWebStream(
                  res.body,
                  { mimeType: file.type, size: file.size },
                  { duration: true, skipCovers: true, skipPostHeaders: true },
                );
                duration = metadata.format?.duration || 0;

                // Immediately cancel the stream to save bandwidth and memory!
                try {
                  res.body.cancel();
                } catch (_e) {
                  // Ignore
                }
              }
            }
          } catch (err) {
            console.warn(
              `[upload-finalize] Background duration parse failed for ${file.name}:`,
              err,
            );
          }

          return {
            ...existingAf,
            duration,
            metadata: {
              ...existingAf.metadata,
              duration,
            },
          };
        });

        const updatedAudioFilesJson = await Promise.all(metadataPromises);

        // Merge the fully parsed new files back into the overall book audio_files array
        const finalMergedAudioFiles = [
          ...(existingBook?.audio_files || []),
          ...updatedAudioFilesJson,
        ];

        // Deduplicate the merged files to prevent duplicate chapters and incorrect playtime on re-uploads
        const uniqueMergedMap = new Map<string, any>();
        for (const af of finalMergedAudioFiles) {
          if (af.metadata?.filename) {
            uniqueMergedMap.set(af.metadata.filename, af);
          }
        }
        const deduplicatedMergedFiles = Array.from(uniqueMergedMap.values());
        deduplicatedMergedFiles.forEach((af, idx) => af.index = idx + 1);

        const totalDuration = deduplicatedMergedFiles.reduce(
          (sum: number, af: any) => sum + (af.duration || 0),
          0,
        );

        // Update database with new durations
        await db.from("library_items").update({
          audio_files: deduplicatedMergedFiles,
          duration: totalDuration,
        }).eq("id", bookId);
        console.log(
          `[upload-finalize] Successfully updated duration for book ${bookId} to ${totalDuration}s`,
        );
      } catch (err) {
        console.error(
          `[upload-finalize] Background duration extraction failed for book ${bookId}:`,
          err,
        );
      }
    };

    // Spawn detached task depending on environment
    // @ts-ignore
    if (
      typeof (globalThis as any).EdgeRuntime !== "undefined" &&
      typeof (globalThis as any).EdgeRuntime.waitUntil === "function"
    ) {
      // @ts-ignore
      (globalThis as any).EdgeRuntime.waitUntil(processDurationsAsync());
    } else {
      processDurationsAsync().catch(() => {});
    }
    // ------------------------------------------------

    if (author) {
      // Clear old author associations so re-uploads with different metadata remove the old associations
      await db.from("book_authors").delete().eq(
        "library_item_id",
        libraryItemId,
      );

      // Split on /, comma, or " & " / " and "
      const rawAuthors = author.split(/\s*(?:\/|,|&|\band\b)\s*/i).map((
        a: string,
      ) => a.trim()).filter(Boolean);

      const cleanAuthors = rawAuthors.map((a: string) => {
        let name = a;
        // Strip leaked titles if appended via " - "
        const dashSplit = name.split(" - ");
        if (dashSplit.length > 1) {
          name = dashSplit[0];
        }

        // Strip common degrees
        name = name.replace(/\b(Ph\.?D\.?|M\.?D\.?)\b/gi, "");

        // Remove periods after initials
        name = name.replace(/([A-Za-z])\./g, "$1");

        // Collapse spaces
        return name.replace(/\s+/g, " ").trim();
      }).filter(Boolean);

      // Remove duplicates from the array
      const uniqueAuthors = Array.from(new Set(cleanAuthors));

      for (const singleAuthor of uniqueAuthors) {
        await db.from("authors").upsert({
          id: crypto.randomUUID(),
          name: singleAuthor,
          library_id: libraryId,
        }, { onConflict: "library_id, name", ignoreDuplicates: true });

        const { data: existingAuthor } = await db.from("authors").select("id")
          .eq(
            "name",
            singleAuthor,
          ).eq("library_id", libraryId).single();

        const authorId = existingAuthor?.id;
        if (authorId) {
          await db.from("book_authors").upsert({
            library_item_id: libraryItemId,
            author_id: authorId,
          }, {
            onConflict: "library_item_id, author_id",
            ignoreDuplicates: true,
          });
        }
      }

      // Update library_items with the original raw string as a fallback for simple text fields
      await db.from("library_items").update({
        author_names_first_last: author,
      }).eq("id", libraryItemId);
    }

    if (series) {
      // Clear old series associations so re-uploads with different metadata remove the old associations
      await db.from("book_series").delete().eq(
        "library_item_id",
        libraryItemId,
      );

      // Split series just in case, although less common
      const rawSeries = series.split(/\s*(?:\/|,|&|\band\b)\s*/i).map((
        s: string,
      ) => s.trim()).filter(Boolean);
      const uniqueSeries = Array.from(new Set(rawSeries));

      for (const singleSeries of uniqueSeries) {
        await db.from("series").upsert({
          id: crypto.randomUUID(),
          name: singleSeries,
          library_id: libraryId,
        }, { onConflict: "library_id, name", ignoreDuplicates: true });

        const { data: existingSeries } = await db.from("series").select("id")
          .eq(
            "name",
            singleSeries,
          ).eq("library_id", libraryId).single();

        const seriesId = existingSeries?.id;
        if (seriesId) {
          await db.from("book_series").upsert({
            library_item_id: libraryItemId,
            series_id: seriesId,
          }, {
            onConflict: "library_item_id, series_id",
            ignoreDuplicates: true,
          });
        }
      }
    }

    // --- Z.AI AUTOMATED METADATA ENRICHMENT ---
    if (title && zaiApiKey) {
      const enrichAsync = async () => {
        try {
          const aiRes = await fetch(
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${zaiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "glm-4-flash",
                messages: [{
                  role: "user",
                  content:
                    `Generate a concise executive summary (description), top 3 genres/tags, and published year for the audiobook "${title}" by ${
                      author || "Unknown Author"
                    }. Return ONLY a JSON object: {"description": "...", "genres": ["..."], "publishedYear": "YYYY"}`,
                }],
                temperature: 0.2,
              }),
            },
          );
          if (aiRes.ok) {
            const aiData = await aiRes.json();
            const text = aiData.choices?.[0]?.message?.content || "";
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
              const enriched = JSON.parse(match[0]);
              await db.from("library_items").update({
                description: enriched.description || undefined,
                genres: enriched.genres || undefined,
                published_year: enriched.publishedYear || undefined,
              }).eq("id", libraryItemId);
              console.log(
                `[upload-finalize] Z.AI successfully enriched metadata for "${title}"`,
              );
            }
          }
        } catch (_err) {
          // Silent enrichment fallback
        }
      };

      // @ts-ignore
      if (
        typeof (globalThis as any).EdgeRuntime !== "undefined" &&
        typeof (globalThis as any).EdgeRuntime.waitUntil === "function"
      ) {
        // @ts-ignore
        (globalThis as any).EdgeRuntime.waitUntil(enrichAsync());
      } else {
        enrichAsync().catch(() => {});
      }
    }

    return new Response(
      JSON.stringify({ success: true, libraryItemId, bookId }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: unknown) {
    const err = e as Error;
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function sortFilesWithZAI(
  filenames: string[],
  zaiApiKey: string,
): Promise<string[]> {
  if (filenames.length <= 1 || !zaiApiKey) return filenames;
  try {
    const aiRes = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${zaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "glm-4-flash",
          messages: [{
            role: "user",
            content:
              `Sort these audiobook chapter/track filenames in exact narrative chronological order (considering disc numbers, track numbers, prologues, chapters, and parts): ${
                JSON.stringify(filenames)
              }. Return ONLY a JSON array of strings: ["file1.mp3", "file2.mp3", ...]`,
          }],
          temperature: 0.0,
        }),
      },
    );
    if (aiRes.ok) {
      const aiData = await aiRes.json();
      const content = aiData.choices?.[0]?.message?.content || "";
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        const sortedList: string[] = JSON.parse(match[0]);
        if (
          Array.isArray(sortedList) && sortedList.length === filenames.length
        ) {
          console.log(
            "[upload-finalize] Z.AI successfully optimized chapter sequence sorting.",
          );
          return sortedList;
        }
      }
    }
  } catch (e: unknown) {
    const err = e as Error;
    console.warn(
      "[upload-finalize] Z.AI file sorting fallback to natural sort:",
      err.message,
    );
  }
  return filenames.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
}
