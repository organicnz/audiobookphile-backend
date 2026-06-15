import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { corsHeaders } from "../_shared/cors.ts"

// Note: Ensure `EdgeRuntime` is configured in the environment to allow async operations after response
declare const EdgeRuntime: any

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const openAiApiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
    
    // Auth client with service role key to bypass RLS
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders })
    }

    const { data: profile } = await supabase.from('profiles').select('user_type').eq('id', user.id).single()
    if (!profile || !['admin', 'root'].includes(profile.user_type ?? '')) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders })
    }

    const body = await req.json().catch(() => ({}))
    const { libraryItemId } = body

    if (!libraryItemId) {
      return new Response(JSON.stringify({ error: 'libraryItemId is required' }), { status: 400, headers: corsHeaders })
    }
    
    if (!openAiApiKey) {
      return new Response(JSON.stringify({ error: 'OPENAI_API_KEY is not configured on the server' }), { status: 500, headers: corsHeaders })
    }

    // Process embedding asynchronously
    const generateAndSaveEmbedding = async () => {
      try {
        // Fetch the item
        const { data: item, error: fetchErr } = await supabase
          .from('library_items')
          .select('media_id, media_type, author_names_first_last, title')
          .eq('id', libraryItemId)
          .single()

        if (fetchErr || !item) {
          console.error('Library item not found:', libraryItemId)
          return
        }

        let title = item.title || ''
        let authorName = item.author_names_first_last || ''
        let description = ''
        let genresStr = ''

        if (item.media_type === 'book' && item.media_id) {
          const { data: book } = await supabase.from('books').select('title, description, genres').eq('id', item.media_id).single()
          if (book) {
            title = book.title || title
            description = book.description || ''
            if (book.genres && Array.isArray(book.genres)) {
              genresStr = book.genres.join(', ')
            }
          }
        } else if (item.media_type === 'podcast' && item.media_id) {
          const { data: podcast } = await supabase.from('podcasts').select('title, author, description, genres').eq('id', item.media_id).single()
          if (podcast) {
            title = podcast.title || title
            authorName = podcast.author || authorName
            description = podcast.description || ''
            if (podcast.genres && Array.isArray(podcast.genres)) {
              genresStr = podcast.genres.join(', ')
            }
          }
        }

        if (!title && !description) {
          console.error('Item has no title or description to embed')
          return
        }

        const textToEmbed = `Title: ${title}\nAuthor: ${authorName}\nGenres: ${genresStr}\nDescription: ${description}`

        console.log(`Generating embedding for: ${title} by ${authorName}`)

        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openAiApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            input: textToEmbed,
            model: 'text-embedding-3-small'
          })
        })

        if (!res.ok) {
          const errText = await res.text()
          throw new Error(`Failed to fetch from OpenAI API: ${errText}`)
        }

        const data = await res.json()
        if (data.data && data.data.length > 0 && data.data[0].embedding) {
          const embeddingVector = data.data[0].embedding

          // Save the embedding
          const { error: updateErr } = await supabase
            .from('library_items')
            .update({ embedding: embeddingVector } as any)
            .eq('id', libraryItemId)

          if (updateErr) {
            console.error('Failed to update library_items with embedding:', updateErr)
          } else {
            console.log(`Successfully saved embedding for ${libraryItemId}`)
          }
        } else {
          console.error('No embedding data returned from OpenAI.')
        }
      } catch (e) {
        console.error('Embedding generation error:', e)
      }
    }

    // WaitUntil lets the execution continue after returning a response
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(generateAndSaveEmbedding())
    } else {
      // Fallback for local testing if not using actual EdgeRuntime
      generateAndSaveEmbedding()
    }

    return new Response(JSON.stringify({ success: true, message: 'Embedding generation started asynchronously' }), { 
      status: 202, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })

  } catch (e: unknown) {
    const err = e as Error;
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    })
  }
})
