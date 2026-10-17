import type { Prisma, PrismaClient } from '@prisma/client'

export const ACTIVITY_TYPES = [
  'ASSIGNED',
  'UNASSIGNED',
  'STATUS_CHANGED',
  'PRIORITY_CHANGED',
  'CATEGORY_CHANGED',
  'TAG_ADDED',
  'TAG_REMOVED',
  'REOPENED',
  'RESOLVED',
  'CLOSED',
  'MERGED',
  'CSAT_RECEIVED',
] as const

export type ActivityType = (typeof ACTIVITY_TYPES)[number]

// ASSIGNED fires when a new assignee is set; `toUserId` is therefore always
// a real user id. `fromUserId` is null when the ticket had no prior assignee.
export interface AssignedMeta        { fromUserId: string | null; toUserId: string }
// UNASSIGNED fires only when the assignee is being REMOVED, so `fromUserId`
// is always a real user id. We intentionally drop `toUserId` here: the
// previous shape (`toUserId: null`) tripped strict consumers that expected
// the string-typed AssignedMeta. Separating the shape keeps both types
// tight and makes downstream handlers type-safe.
export interface UnassignedMeta      { fromUserId: string }
export interface StatusChangedMeta   { from: string; to: string }
export interface PriorityChangedMeta { from: string; to: string }
export interface CategoryChangedMeta { from: string; to: string }
export interface TagMeta             { tagId: string; tagName: string; tagColor: string | null }
export interface CsatMeta            { rating: number }
export interface MergedMeta          { mergedFromTicketId: string }

export type ActivityMetadata =
  | AssignedMeta
  | UnassignedMeta
  | StatusChangedMeta
  | PriorityChangedMeta
  | CategoryChangedMeta
  | TagMeta
  | CsatMeta
  | MergedMeta
  | undefined

type TxOrClient =
  | PrismaClient
  | Prisma.TransactionClient

export interface EmitActivityInput {
  ticketId: string
  actorUserId: string | null
  type: ActivityType
  metadata?: ActivityMetadata
}

export async function emitActivity(
  tx: TxOrClient,
  input: EmitActivityInput,
): Promise<void> {
  await tx.supportActivity.create({
    data: {
      ticketId: input.ticketId,
      actorUserId: input.actorUserId,
      type: input.type,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
    },
  })
}
