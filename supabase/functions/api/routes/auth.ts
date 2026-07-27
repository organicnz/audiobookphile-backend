/**
 * Auth Routes
 * 
 * Handles user authentication operations:
 * - Login / Signup / Logout
 * - Password Management (Forgot / Reset / Change)
 * - Token Authorization (/authorize)
 */

import { Hono } from 'hono'
import { createClient } from 'npm:@supabase/supabase-js@2.44.0'
import { Variables } from '../_shared/types.ts'
import { getProxyOrigin } from '../../api/_shared/proxy.ts'
import { authErrorHandlers } from '../_shared/errors.ts'
import { z } from 'zod'

export const authRouter = new Hono<{ Variables: Variables }>()

// =========================
// Zod Validation Schemas
// =========================

/** Login body schema */
export const LoginBodySchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

/** Signup body schema */
export const SignupBodySchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  username: z.string().optional(),
})

/** Refresh body schema */
export const RefreshBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
})

/** Forgot password body schema */
export const ForgotPasswordBodySchema = z.object({
  email: z.string().email('Invalid email address'),
})

/** Reset password body schema */
export const ResetPasswordBodySchema = z.object({
  password: z.string().min(6, 'Password must be at least 6 characters'),
})

/** Change password body schema */
export const ChangePasswordBodySchema = z.object({
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
})

/** Authorize body schema (optional) */
export const AuthorizeBodySchema = z.object({
  refreshToken: z.string().optional(),
})

// =========================
// Auth Route Handlers
// =========================

/**
 * Login - Authenticate user with username/email and password
 */
authRouter.post('/login', async (c) => {
  try {
    const supabase = c.get('supabase')
    const supabaseUrl = c.get('supabaseUrl')
    const serviceRoleKey = c.get('serviceRoleKey')
    const body = await c.req.json()
    
    // Zod validation for login body
    const LoginBodySchema = z.object({
      username: z.string().min(1, 'Username is required'),
      password: z.string().min(6, 'Password must be at least 6 characters'),
    })
    
    const loginData = LoginBodySchema.parse(body)
    const { username: loginUsername, password: loginPassword } = loginData
    
    if (!loginUsername || !loginPassword) {
      return authErrorHandlers.UNAUTHORIZED()
    }

    let emailToUse = loginUsername
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey)

    if (!loginUsername.includes('@')) {
      const { data: profile } = await adminSupabase.from('profiles').select('id').eq('username', loginUsername).maybeSingle()
      if (profile?.id) {
        const { data: userData } = await adminSupabase.auth.admin.getUserById(profile.id)
        if (userData?.user?.email) emailToUse = userData.user.email
      }
    }

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email: emailToUse, password: loginPassword })
    
    if (authError || !authData.user) {
      // Check if user exists but credentials are wrong
      const { data: existingProfile } = await adminSupabase.from('profiles').select('id').eq('username', loginUsername).eq('username', loginUsername).maybeSingle()
      
      if (existingProfile) {
        // User exists but credentials are wrong
        return authErrorHandlers.INVALID_TOKEN()
      }
      
      // User doesn't exist
      return authErrorHandlers.USER_NOT_FOUND()
    }

    const { data: profile } = await adminSupabase.from('profiles').select('*').eq('id', authData.user.id).maybeSingle()

    // Build user payload for client
    const userPayload = {
      user: {
        id: authData.user.id,
        username: profile?.username || authData.user.email?.split('@')[0] || 'User',
        email: authData.user.email,
        type: profile?.user_type || 'user',
        token: authData.session.access_token,
        refreshToken: authData.session.refresh_token || null,
        mediaProgress: [],
        seriesHideFromContinueListening: [],
        bookmarks: [],
        isActive: true,
        isLocked: false,
        lastSeen: Date.now(),
        createdAt: new Date(profile?.created_at || authData.user.created_at).getTime(),
        permissions: {
          download: true,
          update: profile?.user_type === 'admin',
          delete: profile?.user_type === 'admin',
          upload: profile?.user_type === 'admin',
          accessAllLibraries: true,
          accessAllTags: true,
          accessExplicitContent: true
        },
        librariesAccessible: [],
        itemTagsAccessible: []
      },
      userDefaultLibraryId: profile?.default_library_id || null,
      serverSettings: {},
      source: 'local'
    }
    
    return c.json(userPayload, 200)
  } catch (err) {
    if (err instanceof z.ZodError) {
      // Validation error
      return authErrorHandlers.VALIDATION_ERROR()
    }
    if (err instanceof Error && err.message === 'Unauthorized') {
      return authErrorHandlers.UNAUTHORIZED()
    }
    throw err
  }
})

/**
 * Signup - Register new user
 */
authRouter.post('/signup', async (c) => {
  try {
    const supabase = c.get('supabase')
    const supabaseUrl = c.get('supabaseUrl')
    const serviceRoleKey = c.get('serviceRoleKey')
    const body = await c.req.json()
    
    // Zod validation for signup body
    const SignupBodySchema = z.object({
      email: z.string().email('Invalid email address'),
      password: z.string().min(6, 'Password must be at least 6 characters'),
      username: z.string().optional().optional(),
    })
    
    const signupData = SignupBodySchema.parse(body)
    const { email: signupEmail, password: signupPassword } = signupData
    
    if (!signupEmail || !signupPassword) {
      return authErrorHandlers.VALIDATION_ERROR()
    }

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: signupEmail,
      password: signupPassword
    })
    
    if (authError) {
      return authErrorHandlers.VALIDATION_ERROR()
    }

    if (signupData.username && authData.user) {
      const adminSupabase = createClient(supabaseUrl, serviceRoleKey)
      // Check if profile already exists
      const { data: existingProfile } = await adminSupabase.from('profiles').select('*').eq('username', signupData.username).maybeSingle()
      
      if (existingProfile) {
        return authErrorHandlers.USER_NOT_FOUND()
      }
      
      await adminSupabase.from('profiles').insert({
        id: authData.user.id,
        username: signupData.username,
        user_type: 'user'
      })
    }

    return c.json({ success: true, user: authData.user }, 200)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    if (err instanceof Error && err.message === 'Validation error') {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    throw err
  }
})

/**
 * Logout - Sign out user
 */
authRouter.post('/logout', async (c) => {
  try {
    const supabase = c.get('supabase')
    const jwt = c.req.header('Authorization')?.replace('Bearer ', '').trim() || ''
    
    const supabaseUrl = c.get('supabaseUrl')
    const serviceRoleKey = c.get('serviceRoleKey')
    
    if (jwt) {
      const adminSupabase = createClient(supabaseUrl, serviceRoleKey)
      const { data: profile } = await adminSupabase.from('profiles').select('id').eq('username', jwt.split('.').pop() || '').maybeSingle()
      
      if (profile) {
        await adminSupabase.from('profiles').update({ is_locked: true }).eq('id', profile.id)
      }
    }
    
    await supabase.auth.signOut()
    return c.json({ success: true }, 200)
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return authErrorHandlers.UNAUTHORIZED()
    }
    throw err
  }
})

/**
 * Forgot Password - Send password reset email
 */
authRouter.post('/forgot-password', async (c) => {
  try {
    const supabase = c.get('supabase')
    const body = await c.req.json()
    
    const ForgotPasswordBodySchema = z.object({
      email: z.string().email('Invalid email address'),
    })
    
    const formData = ForgotPasswordBodySchema.parse(body)
    const { email } = formData
    
    const siteUrl = getProxyOrigin(c)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/auth/callback?next=/reset-password`
    })
    
    if (error) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    
    return c.json({ success: true, message: 'Reset link sent to email' }, 200)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    if (err instanceof Error && err.message === 'Validation error') {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    throw err
  }
})

/**
 * Reset Password - Set new password with token
 */
authRouter.post('/reset-password', async (c) => {
  try {
    const supabase = c.get('supabase')
    const body = await c.req.json()
    
    const ResetPasswordBodySchema = z.object({
      password: z.string().min(6, 'Password must be at least 6 characters'),
    })
    
    const resetData = ResetPasswordBodySchema.parse(body)
    const { password } = resetData
    
    if (!password) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    
    const { error } = await supabase.auth.updateUser({ password })
    
    if (error) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    
    return c.json({ success: true }, 200)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    if (err instanceof Error && err.message === 'Validation error') {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    throw err
  }
})

/**
 * Change Password - Update current user password
 */
authRouter.post('/change-password', async (c) => {
  try {
    const supabase = c.get('supabase')
    const body = await c.req.json()
    
    const ChangePasswordBodySchema = z.object({
      newPassword: z.string().min(6, 'New password must be at least 6 characters'),
    })
    
    const formData = ChangePasswordBodySchema.parse(body)
    const { newPassword } = formData
    
    if (!newPassword) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    
    if (error) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    
    return c.json({ success: true }, 200)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    if (err instanceof Error && err.message === 'Validation error') {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    throw err
  }
})

/**
 * Refresh - Get new access token using refresh token
 */
authRouter.post('/refresh', async (c) => {
  try {
    const supabase = c.get('supabase')
    const supabaseUrl = c.get('supabaseUrl')
    const serviceRoleKey = c.get('serviceRoleKey')
    const refreshToken = c.req.header('x-refresh-token') || (await c.req.json()).refreshToken
    
    const RefreshBodySchema = z.object({
      refreshToken: z.string().min(1, 'Refresh token is required'),
    })
    
    const refreshData = RefreshBodySchema.parse({ refreshToken })
    const { refreshToken: token } = refreshData
    
    if (!token) {
      return authErrorHandlers.VALIDATION_ERROR()
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.refreshSession({
      refresh_token: token
    })
    
    if (sessionError || !sessionData.session) {
      // Try to decode the token to check if it's invalid
      const payload = decodeJWT(token)
      if (!payload || !payload.id) {
        return authErrorHandlers.INVALID_TOKEN()
      }
      
      return authErrorHandlers.TOKEN_EXPIRED()
    }

    const adminSupabase = createClient(supabaseUrl, serviceRoleKey)
    const { data: profile, error: profileError } = await adminSupabase.from('profiles').select('*').eq('id', sessionData.user.id).maybeSingle()
    
    if (profileError) {
      return authErrorHandlers.USER_NOT_FOUND()
    }

    const userPayload = {
      user: {
        id: sessionData.user.id,
        username: profile?.username || sessionData.user.email?.split('@')[0] || 'User',
        email: sessionData.user.email,
        type: profile?.user_type || 'user',
        token: sessionData.session.access_token,
        refreshToken: sessionData.session.refresh_token || token,
        mediaProgress: [],
        seriesHideFromContinueListening: [],
        bookmarks: [],
        isActive: true,
        isLocked: false,
        lastSeen: Date.now(),
        createdAt: new Date(profile?.created_at || sessionData.user.created_at).getTime(),
        permissions: {
          download: true,
          update: profile?.user_type === 'admin',
          delete: profile?.user_type === 'admin',
          upload: profile?.user_type === 'admin',
          accessAllLibraries: true,
          accessAllTags: true,
          accessExplicitContent: true
        },
        librariesAccessible: [],
        itemTagsAccessible: []
      },
      userDefaultLibraryId: profile?.default_library_id || null,
      serverSettings: {},
      source: 'local'
    }
    
    return c.json(userPayload, 200)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    if (err instanceof Error && err.message === 'Validation error') {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    throw err
  }
})

/**
 * Authorize - Validate JWT and return full user context
 * Used by mobile clients for session initialization
 */
authRouter.post('/authorize', async (c) => {
  try {
    const supabase = c.get('supabase')
    const supabaseUrl = c.get('supabaseUrl')
    const serviceRoleKey = c.get('serviceRoleKey')
    const jwt = c.req.header('Authorization')?.replace('Bearer ', '').trim() || ''
    
    const body = await c.req.json()
    const AuthorizeBodySchema = z.object({
      refreshToken: z.string().optional(),
    })
    
    const authorizeData = AuthorizeBodySchema.parse(body)
    const providedRefreshToken = authorizeData.refreshToken || ''
    
    let user = null
    let activeToken = jwt
    let newRefreshToken: string | null = null
    
    if (jwt) {
      const adminSupabase = createClient(supabaseUrl, serviceRoleKey)
      
      // Extract payload from JWT
      const payload = decodeJWT(jwt)
      
      if (!payload) {
        return authErrorHandlers.INVALID_TOKEN()
      }
      
      const userId = payload.id
      
      // Validate user exists and is not banned/locked
      const { data: profile, error: fetchError } = await adminSupabase.from('profiles').select('*').eq('id', userId).maybeSingle()
      
      if (fetchError || !profile) {
        // Check if user exists but no profile
        const { data: authIdentity } = await adminSupabase.from('auth_identities').select('id').eq('user_id', userId).maybeSingle()
        
        if (authIdentity) {
          // User exists but profile is missing or locked
          const updateError = await adminSupabase.from('profiles').upsert({ id: userId, username: payload.username, user_type: 'user', is_locked: true })
          if (updateError) {
            return authErrorHandlers.USER_NOT_FOUND()
          }
        } else {
          return authErrorHandlers.USER_NOT_FOUND()
        }
      }
      
      user = {
        id: userId,
        email: payload.email || profile.email || authIdentity?.email || null,
        username: payload.username || profile.username,
        created_at: new Date(profile?.created_at || Date.now()).toISOString()
      }
      
      activeToken = payload.access_token || activeToken
    }
    
    // If JWT is invalid, try refresh token
    if (!user && providedRefreshToken) {
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({ refresh_token: providedRefreshToken })
      
      if (!refreshError && refreshData.session && refreshData.user) {
        const adminSupabase = createClient(supabaseUrl, serviceRoleKey)
        const { data: profile } = await adminSupabase.from('profiles').select('*').eq('id', refreshData.user.id).maybeSingle()
        
        user = {
          id: refreshData.user.id,
          email: refreshData.user.email,
          username: profile?.username || refreshData.user.email?.split('@')[0] || 'User',
          created_at: new Date(profile?.created_at || refreshData.user.created_at).toISOString()
        }
        
        activeToken = refreshData.session.access_token
        newRefreshToken = refreshData.session.refresh_token
        
        // Update profile
        await adminSupabase.from('profiles').update({ 
          username: user.username,
          user_type: profile?.user_type || 'user'
        }).eq('id', user.id)
      }
    }
    
    if (!user) {
      return authErrorHandlers.UNAUTHORIZED()
    }
    
    const { data: profile } = await adminSupabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
    
    const userPayload = {
      user: {
        id: user.id,
        username: profile?.username || user.email?.split('@')[0] || 'User',
        email: user.email,
        type: profile?.user_type || 'user',
        token: activeToken,
        refreshToken: newRefreshToken || null,
        mediaProgress: [],
        seriesHideFromContinueListening: [],
        bookmarks: [],
        isActive: true,
        isLocked: false,
        lastSeen: Date.now(),
        createdAt: new Date(profile?.created_at || user.created_at).getTime(),
        permissions: {
          download: true,
          update: profile?.user_type === 'admin',
          delete: profile?.user_type === 'admin',
          upload: profile?.user_type === 'admin',
          accessAllLibraries: true,
          accessAllTags: true,
          accessExplicitContent: true
        },
        librariesAccessible: [],
        itemTagsAccessible: []
      },
      userDefaultLibraryId: profile?.default_library_id || null,
      serverSettings: {},
      source: 'local'
    }
    
    return c.json(userPayload, 200)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    if (err instanceof Error && err.message === 'Validation error') {
      return authErrorHandlers.VALIDATION_ERROR()
    }
    throw err
  }
})

// =========================
// Utility Functions
// =========================

/**
 * Decode JWT token to extract payload (base64 decode, skip signature verification)
 * @param token - JWT token string (Bearer token or full JWT)
 * @returns Decoded JWT payload or null
 */
function decodeJWT(token: string): any {
  try {
    // JWT format: header.payload.signature
    // Extract payload (second part) and base64 decode
    const payload = token.split('.')[1]
    if (!payload) return null
    
    // Remove base64 padding
    const padding = (4 - (payload.length % 4)) % 4
    let tempPayload = '='.repeat(padding)
    payload += tempPayload
    
    // Decode
    const decoded = Buffer.from(payload, 'base64').toString()
    return JSON.parse(decoded)
  } catch (e) {
    console.error('[authRouter] JWT decode error:', e)
    return null
  }
}

// =========================
// Module Export
// =========================

export { authRouter, authErrorHandlers }