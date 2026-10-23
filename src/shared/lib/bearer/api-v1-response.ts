import { NextResponse } from 'next/server'
import { AppError, ValidationError } from '../errors'
import { logger } from '../logger'
import { BearerInvalidError } from './errors'

/** The error body of every /api/v1 answer: `{ "error": { "code", "message" } }`, with fieldErrors for a validation. */
export interface ApiV1ErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> }
}

/**
 * The /api/v1 answer of an error that a bearer route raised: an AppError answers with its code and status, a
 * ValidationError with 400 VALIDATION_FAILED and its field errors, and BearerInvalidError adds the invalid_token
 * challenge. Any other error is logged and answers 500 INTERNAL_ERROR without its message.
 */
export function apiV1ErrorResponse(error: unknown): NextResponse<ApiV1ErrorBody> {
  if (error instanceof ValidationError) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: error.message, fieldErrors: error.fieldErrors } },
      { status: 400 },
    )
  }
  if (error instanceof AppError) {
    const headers: Record<string, string> =
      error instanceof BearerInvalidError ? { 'WWW-Authenticate': 'Bearer error="invalid_token"' } : {}
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.statusCode, headers })
  }
  logger.error('Unhandled /api/v1 error', error instanceof Error ? error : new Error(String(error)))
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { status: 500 })
}
