import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Database } from "../../src/types/supabase.ts"

serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    
    // Auth client with service role key to bypass RLS
    const supabase = createClient<Database>(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
    
    // Verify user is an admin or the request comes from cron with service key
    const isCron = authHeader.replace('Bearer ', '') === supabaseServiceKey
    
    if (!isCron) {
      // Check if user is admin
      const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
      if (userError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      }
      
      const { data: profile } = await supabase
        .from('profiles')
        .select('user_type')
        .eq('id', user.id)
        .single()
        
      if (!profile || !['admin', 'root'].includes(profile.user_type)) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
      }
    }

    console.log('Starting automated database backup...')

    // 1. Fetch library metadata (books, podcasts, authors, series)
    const { data: libraries, error: libErr } = await supabase.from('libraries').select('*')
    const { data: libraryItems, error: itemsErr } = await supabase.from('library_items').select('*')
    const { data: mediaProgress, error: progErr } = await supabase.from('media_progress').select('*')
    const { data: serverSettings, error: setErr } = await supabase.from('server_settings').select('*')

    if (libErr || itemsErr || progErr || setErr) {
      throw new Error('Failed to fetch data for backup')
    }

    const backupData = {
      timestamp: new Date().toISOString(),
      libraries,
      libraryItems,
      mediaProgress,
      serverSettings
    }

    const backupJson = JSON.stringify(backupData, null, 2)
    const filename = `backup-${new Date().toISOString().split('T')[0]}.json`

    // 2. Upload to storage
    const { data, error: uploadErr } = await supabase.storage
      .from('backups')
      .upload(filename, backupJson, {
        contentType: 'application/json',
        upsert: true
      })

    if (uploadErr) {
      console.error('Upload Error:', uploadErr)
      throw new Error(`Failed to upload backup: ${uploadErr.message}`)
    }

    console.log(`Backup completed successfully: ${filename}`)

    return new Response(JSON.stringify({ success: true, message: 'Backup created', filename }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    })

  } catch (e: unknown) {
    const err = e as Error;
    console.error('Backup failed:', err)
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    })
  }
})
