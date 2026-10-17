import { z } from 'zod'

export const createTicketSchema = z.object({
  subject: z.string().min(5, 'Subject must be at least 5 characters').max(200),
  descriptionRich: z.string().min(10).max(50_000),
  descriptionPlain: z.string().min(10).max(50_000),
  priority: z.string().default('MEDIUM'),
  category: z.string().default('GENERAL'),
  attachments: z.array(z.object({
    storageKey: z.string(),
    thumbnailKey: z.string().nullable(),
    fileName: z.string(),
    fileSize: z.number().int().positive(),
    mimeType: z.string(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
  })).optional(),
})

export const updateTicketSchema = z.object({
  id: z.string(),
  subject: z.string().min(5).max(200).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  category: z.string().optional(),
  assignedToUserId: z.string().nullable().optional(),
})

export const sendMessageSchema = z.object({
  ticketId: z.string(),
  bodyRich: z.string().min(1).max(50_000),
  bodyPlain: z.string().min(1).max(50_000),
  isInternal: z.boolean().optional().default(false),
  attachments: z.array(z.object({
    storageKey: z.string(),
    thumbnailKey: z.string().nullable(),
    fileName: z.string(),
    fileSize: z.number().int().positive(),
    mimeType: z.string(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
  })).optional(),
})

export const editMessageSchema = z.object({
  id: z.string(),
  bodyRich: z.string().min(1).max(50_000),
  bodyPlain: z.string().min(1).max(50_000),
})

export const deleteMessageSchema = z.object({
  id: z.string(),
})

export const createTagSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only'),
  colorCode: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  description: z.string().max(200).optional(),
  tenantId: z.string().nullable().optional(),
})

export const addTagSchema = z.object({
  ticketId: z.string(),
  tagId: z.string(),
})

export const removeTagSchema = z.object({
  ticketId: z.string(),
  tagId: z.string(),
})

export const reopenTicketSchema = z.object({
  id: z.string(),
})

export const submitCsatSchema = z.object({
  ticketId: z.string(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
})

export const inboxFiltersSchema = z.object({
  view: z.enum(['open', 'mine', 'unassigned', 'high', 'all', 'closed']).default('open'),
  priority: z.string().array().optional(),
  tags: z.string().array().optional(),
  q: z.string().optional(),
  assignee: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
})

export type CreateTicketData    = z.infer<typeof createTicketSchema>
export type UpdateTicketData    = z.infer<typeof updateTicketSchema>
export type SendMessageData     = z.infer<typeof sendMessageSchema>
export type EditMessageData     = z.infer<typeof editMessageSchema>
export type DeleteMessageData   = z.infer<typeof deleteMessageSchema>
export type CreateTagData       = z.infer<typeof createTagSchema>
export type AddTagData          = z.infer<typeof addTagSchema>
export type RemoveTagData       = z.infer<typeof removeTagSchema>
export type ReopenTicketData    = z.infer<typeof reopenTicketSchema>
export type SubmitCsatData      = z.infer<typeof submitCsatSchema>
export type InboxFilters        = z.infer<typeof inboxFiltersSchema>
