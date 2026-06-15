import { Hono } from "npm:hono"
import { upsertMediaProgress } from "../../_shared/progress.ts"
import { Variables } from "../_shared/types.ts"

export const progressRouter = new Hono<{ Variables: Variables }>()

progressRouter.patch('/me/progress/:id', async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')!
  const libraryItemId = c.req.param('id')
  const body = await c.req.json()

  const data = await upsertMediaProgress(supabase, user.id, libraryItemId, body.episodeId, {
    progress: body.progress,
    duration: body.duration,
    isFinished: body.isFinished,
    hideFromContinueListening: body.hideFromContinueListening
  })
  
  return c.json(data)
})

progressRouter.patch('/me/progress-batch', async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')!
  const items = await c.req.json()
  
  for (const item of items) {
    await upsertMediaProgress(supabase, user.id, item.libraryItemId, item.episodeId, {
      progress: item.progress,
      duration: item.duration,
      isFinished: item.isFinished,
      hideFromContinueListening: item.hideFromContinueListening
    })
  }
  return c.json({ success: true })
})

progressRouter.patch('/me/progress/series/:id', async (c) => {
  // For series, we might update a separate table or user preferences
  return c.json({ success: true, message: 'Not fully implemented for Supabase yet' })
})

progressRouter.delete('/me/progress/id/:id', async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')!
  const progressId = c.req.param('id')
  
  const { error } = await supabase.from('media_progress').delete().eq('id', progressId).eq('user_id', user.id)
  if (error) throw error
  return c.json({ success: true })
})
