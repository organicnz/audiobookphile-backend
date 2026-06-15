import { Hono } from "npm:hono"
import { createClient } from "npm:@supabase/supabase-js"
import { Variables } from "../_shared/types.ts"

export const migrateBatchRouter = new Hono<{ Variables: Variables }>()

migrateBatchRouter.post('/', async (c) => {
  const supabaseUrl = c.get('supabaseUrl')
  const serviceRoleKey = c.get('serviceRoleKey')
  const adminClient = createClient(supabaseUrl, serviceRoleKey)
  const { table, rows } = await c.req.json()
  
  if (!table || !rows || !Array.isArray(rows)) {
    return c.json({ error: 'Invalid payload' }, 400)
  }

  console.log(`Upserting ${rows.length} rows to ${table}...`)
  const { data, error } = await adminClient.from(table).upsert(rows, { onConflict: 'id' }).select('id')
  console.log(`Upsert result: data length ${data?.length}, error`, error)
  if (error) {
    console.error(`Migration error for ${table}:`, error)
    return c.json({ error: error.message }, 500)
  }

  return c.json({ success: true, count: rows.length })
})
