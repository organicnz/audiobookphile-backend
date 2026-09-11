/**
 * Auth Domain Module — Pure business logic for authentication operations.
 *
 * Extracted from routes/auth.ts to separate HTTP concerns from domain logic.
 * Contains Zod schemas, validation helpers, and auth business rules.
 */

import { z } from "zod";

/* =========================================================================
 * Zod Validation Schemas
 *
 * All auth request body schemas in one place. Routes import these directly
 * rather than defining them inline, ensuring consistency across the API
 * and tests.
 * ========================================================================= */

/** Login body schema */
export const LoginBodySchema = z.object({
  username: z.string().min(1, "Username or email is required"),
  password: z.string().min(1, "Password is required"),
});

/** Signup body schema */
export const SignupBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  username: z.string().optional(),
});

/** Refresh body schema */
export const RefreshBodySchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

/** Forgot password body schema */
export const ForgotPasswordBodySchema = z.object({
  email: z.string().email("Invalid email address"),
});

/** Reset password body schema */
export const ResetPasswordBodySchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  token: z.string().optional(),
  accessToken: z.string().optional(),
});

/** Change password body schema */
export const ChangePasswordBodySchema = z.object({
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

/** Authorize body schema (optional fields) */
export const AuthorizeBodySchema = z.object({
  refreshToken: z.string().optional(),
});

/** Magic link body schema */
export const MagicLinkBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  redirectTo: z.string().optional(),
  client: z.enum(["ios", "web"]).optional(),
  server: z.string().optional(),
});

/** Verify OTP body schema */
export const VerifyOtpBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  token: z.string().min(1, "OTP token is required"),
  type: z.string().optional(),
});

/** Invite user body schema */
export const InviteUserBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  username: z.string().optional(),
  userType: z.string().optional(),
});

/* =========================================================================
 * Auth Type Exports
 * ========================================================================= */

export type LoginBody = z.infer<typeof LoginBodySchema>;
export type SignupBody = z.infer<typeof SignupBodySchema>;
export type RefreshBody = z.infer<typeof RefreshBodySchema>;
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBodySchema>;
export type ResetPasswordBody = z.infer<typeof ResetPasswordBodySchema>;
export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;
export type AuthorizeBody = z.infer<typeof AuthorizeBodySchema>;
export type MagicLinkBody = z.infer<typeof MagicLinkBodySchema>;
export type VerifyOtpBody = z.infer<typeof VerifyOtpBodySchema>;
export type InviteUserBody = z.infer<typeof InviteUserBodySchema>;

/* =========================================================================
 * Password Strength Validation
 * ========================================================================= */

export interface PasswordStrength {
  score: number; // 0-4 (weak to strong)
  feedback: string[];
}

/** Evaluate password strength beyond minimum length. */
export function evaluatePasswordStrength(password: string): PasswordStrength {
  const feedback: string[] = [];
  let score = 0;

  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (password.length < 12) {
    feedback.push("Use 12+ characters for better security");
  }
  if (!/[A-Z]/.test(password)) feedback.push("Add uppercase letters");
  if (!/\d/.test(password)) feedback.push("Add numbers");
  if (!/[^A-Za-z0-9]/.test(password)) feedback.push("Add special characters");

  return { score: Math.min(score, 4), feedback };
}

/* =========================================================================
 * Token Utilities
 * ========================================================================= */

/** Check if a JWT has expired based on its `exp` claim. */
export function isTokenExpired(decodedPayload: { exp?: number }): boolean {
  if (!decodedPayload.exp) return true;
  return Date.now() / 1000 > decodedPayload.exp;
}

/** Calculate remaining token lifetime in seconds. */
export function tokenRemainingSeconds(
  decodedPayload: { exp?: number },
): number {
  if (!decodedPayload.exp) return 0;
  return Math.max(0, decodedPayload.exp - Date.now() / 1000);
}
