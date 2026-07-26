export type { ApiError } from './errors.ts'

/**
 * Create a new API error.
 * @param message - The error message
 * @param code - The error code (default: 'INTERNAL_ERROR')
 * @param details - Optional additional context
 */
export function createApiError(
    message: string,
    code: ApiError['code'] = 'INTERNAL_ERROR',
    details: any = null
): ApiError {
    return new ApiError(message, code, details)
}