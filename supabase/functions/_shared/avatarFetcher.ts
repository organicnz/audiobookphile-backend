import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";

/**
 * Robustly fetches an author's avatar using a 3-tier waterfall logic.
 * 1. Wikipedia (Primary)
 * 2. OpenLibrary (Fallback)
 * 3. DiceBear (Ultimate Fallback)
 *
 * Uploads the result to the "covers" bucket.
 *
 * @param adminClient Supabase client with service_role privileges
 * @param author The author object containing id and name
 * @returns The storage path if successful, otherwise null
 */
export async function fetchAuthorAvatar(
  adminClient: SupabaseClient,
  author: { id: string; name: string },
): Promise<string | null> {
  if (!author.name) return null;

  let storagePath: string | null = null;
  // let noPhotoFound = true;

  // 1. WIKIPEDIA API FETCH (Primary)
  try {
    const wikiRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${
        encodeURIComponent(author.name)
      }&prop=pageimages&format=json&pithumbsize=500&redirects=1`,
    );
    if (wikiRes.ok) {
      const wikiData = await wikiRes.json();
      const pages = wikiData?.query?.pages;
      if (pages) {
        const pageId = Object.keys(pages)[0];
        if (pageId !== "-1" && pages[pageId]?.thumbnail?.source) {
          const photoUrl = pages[pageId].thumbnail.source;
          const imgRes = await fetch(photoUrl);
          if (imgRes.ok) {
            const buf = await imgRes.arrayBuffer();
            if (buf.byteLength > 5000) {
              storagePath = `authors/${author.id}/photo.jpg`;
              const { error: uploadErr } = await adminClient.storage
                .from("covers")
                .upload(storagePath, buf, {
                  upsert: true,
                  contentType: "image/jpeg",
                });

              if (!uploadErr) {
                // noPhotoFound = false;
              } else {
                storagePath = null;
              }
            }
          }
        }
      }
    }
  } catch (e: any) {
    console.log(
      `[Avatar Fetcher] Wikipedia fetch failed for ${author.name}`,
      e.message,
    );
  }

  // 2. OPENLIBRARY API FETCH (Fallback)
  if (!storagePath) {
    try {
      const res = await fetch(
        `https://openlibrary.org/search/authors.json?q="${
          encodeURIComponent(author.name)
        }"&limit=1`,
      );

      if (res.ok) {
        const data = await res.json();
        const doc = data?.docs?.[0];

        if (doc?.key) {
          const keyPath = doc.key.startsWith("/authors/")
            ? doc.key
            : `/authors/${doc.key}`;
          const authorRes = await fetch(
            `https://openlibrary.org${keyPath}.json`,
          );

          if (authorRes.ok) {
            const authorData = await authorRes.json();
            if (authorData?.photos?.[0]) {
              const photoId = authorData.photos[0];
              const photoUrl =
                `https://covers.openlibrary.org/a/id/${photoId}-L.jpg`;

              const imgRes = await fetch(photoUrl);
              if (imgRes.ok) {
                const buf = await imgRes.arrayBuffer();
                if (buf.byteLength > 5000) {
                  storagePath = `authors/${author.id}/photo.jpg`;
                  const { error: uploadErr } = await adminClient.storage
                    .from("covers")
                    .upload(storagePath, buf, {
                      upsert: true,
                      contentType: "image/jpeg",
                    });

                  if (!uploadErr) {
                    // noPhotoFound = false;
                  } else {
                    storagePath = null;
                  }
                }
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.log(
        `[Avatar Fetcher] OpenLibrary fetch failed for ${author.name}`,
        e.message,
      );
    }
  }

  // 3. DICEBEAR API (Ultimate Fallback)
  if (!storagePath) {
    try {
      // Generate a beautiful, deterministic abstract initials avatar
      const diceBearUrl = `https://api.dicebear.com/9.x/initials/svg?seed=${
        encodeURIComponent(author.name)
      }&backgroundColor=000000,1a1a1a,333333&textColor=ffffff&fontWeight=600`;
      const imgRes = await fetch(diceBearUrl);
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        storagePath = `authors/${author.id}/photo.svg`;
        const { error: uploadErr } = await adminClient.storage
          .from("covers")
          .upload(storagePath, buf, {
            upsert: true,
            contentType: "image/svg+xml",
          });

        if (!uploadErr) {
          // noPhotoFound = false;
        } else {
          storagePath = null;
        }
      }
    } catch (e: any) {
      console.log(
        `[Avatar Fetcher] DiceBear fetch failed for ${author.name}`,
        e.message,
      );
    }
  }

  return storagePath;
}
