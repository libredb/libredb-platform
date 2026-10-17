import type { Prisma } from '@prisma/client'

/**
 * Why a revocation ends a subject's Studio sessions, the vocabulary that the CHECK on platform.session_revocations
 * allows: admin for "Revoke Studio sessions" and the break-glass statement of docs/deploy/platform-runtime.md, and the
 * transitions that directory sync detects.
 */
export const SESSION_REVOCATION_REASONS = ['admin', 'user-disabled', 'user-deleted', 'role-removed'] as const

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number]

// The client insertSessionRevocation() writes through: the transaction client of the change the revocation belongs to,
// such as its admin action or the directory snapshot, so that both commit or roll back together.
export type SessionRevocationClient = Pick<Prisma.TransactionClient, 'sessionRevocation'>

export interface SessionRevocationEntry {
  /** The Keycloak user id whose Studio sessions and MCP tokens end. */
  subject: string
  reason: SessionRevocationReason
  /** The users.id of the admin who revokes, or null for directory sync. */
  createdById: string | null
}

export interface InsertedSessionRevocation {
  /** The id the database generated. */
  id: string
  /** Studio refuses every session of the subject issued at or before this time. */
  revokedBefore: Date
}

/**
 * Inserts one deny-only revocation into platform.session_revocations, which ends every Studio session and MCP token of
 * the subject issued until now: its trigger tells Studio after the commit, and Studio reads
 * the latest revokedBefore per subject through bridge.session_revocations_v1.
 * "Revoke Studio sessions" and directory sync share it.
 */
export function insertSessionRevocation(
  tx: SessionRevocationClient,
  entry: SessionRevocationEntry,
): Promise<InsertedSessionRevocation> {
  return tx.sessionRevocation.create({
    data: { subject: entry.subject, reason: entry.reason, createdById: entry.createdById },
    select: { id: true, revokedBefore: true },
  })
}
