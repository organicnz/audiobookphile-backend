import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from 'npm:@supabase/supabase-js@2.44.0'
import { Sentry } from '../_shared/sentry.ts'

// Native Hono Routers
import { settingsRouter } from './routes/settings.ts'
import { debugRouter } from './routes/debug.ts'
import { metadataRouter } from './routes/metadata.ts'
import { authorsRouter } from './routes/authors.ts'
import { usersRouter } from './routes/users.ts'
import { librariesRouter } from './routes/libraries.ts'
import { itemsRouter } from './routes/items.ts'
import { playbackRouter } from './routes/playback.ts'
import { progressRouter } from './routes/progress.ts'
import { playlistsRouter } from './routes/playlists.ts'
import { collectionsRouter } from './routes/collections.ts'
import { authRouter } from './routes/auth.ts'
import { migrateBatchRouter } from './routes/migrateBatch.ts'
import { downloadsRouter } from './routes/downloads.ts'
import { bookmarksRouter } from './routes/bookmarks.ts'
import { searchRouter } from './routes/search.ts'
import { meRouter } from './routes/me.ts'

import { Variables } from './_shared/types.ts'
import { ApiError, serviceRoleMiddleware } from './_shared/errors.ts'
import { authMiddleware, authErrorHandlers } from './_shared/auth.ts'

// === MIDDLEWARE CHAIN ===
// Order matters: logging → error handling → auth → route handlers

// 1. Structured Logging Middleware
app.use(async (c, next) => {
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  const requestId = crypto.randomUUID()
  c.res.headers.set('X-Request-ID', requestId)
  c.set('requestId', requestId)
  
  // Only log in production
  if (Deno.env.get('NODE_ENV') === 'production') {
    const log = {
      level: 'info',
      timestamp: new Date().toISOString(),
      requestId,
      method: c.req.method,
      path: c.req.path,
      url: c.req.url,
      headers: { 'x-client-info': c.req.header('x-client-info') },
      statusCode: c.res.status,
      durationMs: duration,
      user: c.get('user')?.email,
      ip: c.req.env.req.connection.remoteAddress || 'unknown'
    }
    Deno.console.log(JSON.stringify(log))
  }
})

// 2. Auth Middleware (centralized authentication, skips auth routes)
app.use('*', authMiddleware)

// 3. Error Handling Middleware
app.use(async (c, next) => {
  try {
    await next()
  } catch (err) {
    // Distinguish between ApiError (API errors) and generic errors (server errors)
    const apiErr = err as ApiError
    if (apiErr?.statusCode) {
      // API error - return proper JSON response
      c.res = c.json(
        {
          error: {
            code: apiErr.code,
            message: apiErr.message,
            ...(apiErr.field ? { field: apiErr.field } : {}),
            ...(apiErr.validationErrors ? { validationErrors: apiErr.validationErrors } : {})
          },
          requestId: c.get('requestId'),
          timestamp: new Date().toISOString()
        },
        apiErr.statusCode
      )
    } else if (err instanceof Response && err.status >= 500) {
      // Already a Response (from error handler)
      return err
    } else {
      // Generic error - log and return 500
      const errorId = crypto.randomUUID()
      Deno.console.log(
        `[API Index] Unhandled error - Request: ${c.req.method} ${c.req.path} - Error: ${err.message} (${err.constructor.name})`
      )
      // Optionally report to Sentry in production
      if (Deno.env.get('NODE_ENV') === 'production') {
        Sentry.captureException(err)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    }
  }
})

// 4. Additional auth middleware (for protected routes within routers)
// This is for routes that need to call downstream services requiring auth
// Individual route handlers can use the auth middleware as needed

// 5. Service Role Middleware
app.use(serviceRoleMiddleware)

const app = new Hono<{ Variables: Variables }>()

app.get('/api/health', (c) => {
  const zaiConfigured = Boolean(Deno.env.get('ZAI_API_KEY') || Deno.env.get('ZHIPU_API_KEY'))
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2026.07.24',
    services: {
      database: 'connected',
      zai: zaiConfigured ? 'configured' : 'unconfigured'
    }
  })
})

app.use('*', cors({
  origin: '*',
  // x-refresh-token is required for the /authorize silent-refresh path used
  // by the iOS Audiobookshelf client to avoid daily re-authentication prompts.
  allowHeaders: ['authorization', 'x-client-info', 'apikey', 'content-type', 'x-refresh-token']
}))

// === NATIVE HONO ROUTERS ===
// Routes are mounted here, middleware chain applies to all
app.route('/api', settingsRouter)
app.route('/api/debug', debugRouter)
app.route('/api', metadataRouter)
app.route('/api/authors', authorsRouter)
app.route('/api/users', usersRouter)
app.route('/api/libraries', librariesRouter)
app.route('/api/items', itemsRouter)
app.route('/api', playbackRouter)
app.route('/api', progressRouter)
app.route('/api/playlists', playlistsRouter)
app.route('/api/collections', collectionsRouter)
app.route('/api/auth', authRouter)
app.route('/api/migrate-batch', migrateBatchRouter)
app.route('/api/items', downloadsRouter)
app.route('/api/me/bookmarks', bookmarksRouter)
app.route('/api/me/search', searchRouter)
app.route('/api/me', meRouter)

// Fallback 404
app.all('*', (c) => {
  return c.json({ error: 'Endpoint not found or method not supported' }, 404)
})

Deno.serve(app.fetch)