'use client'

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { sendMessage } from '@/features/support/actions/send-message'
import { updateTicket } from '@/features/support/actions/update-ticket'
import type { AttachmentMeta } from './use-attachment-upload'

export interface TicketData {
  id: string; ticketNumber: string; subject: string
  status: string; priority: string; category: string
  tenantId: string | null
  createdByUserId: string; assignedToUserId: string | null
  lastActivityAt: string; firstResponseAt: string | null
  resolvedAt: string | null; closedAt: string | null
  reopenedCount: number
  descriptionRich: string | null; descriptionPlain: string | null
  satisfactionRating: number | null
  createdAt: string; updatedAt: string
  messages: any[]; activities: any[]; tags: any[]
}

async function fetchTicket(id: string): Promise<TicketData> {
  const res = await fetch(`/support/api/ticket/${id}`)
  if (!res.ok) throw new Error('fetch-failed')
  return res.json()
}

export function useTicket(id: string, initialData?: TicketData) {
  return useQuery({
    queryKey: ['ticket', id],
    queryFn: () => fetchTicket(id),
    refetchInterval: (q) => q.state.error ? false : 8_000,
    refetchOnWindowFocus: true,
    initialData,
    staleTime: 0,
  })
}

export function useSendMessage(ticketId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { bodyRich: string; bodyPlain: string; isInternal: boolean; attachments: AttachmentMeta[] }) =>
      sendMessage({ ticketId, ...input }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ticket', ticketId] }),
  })
}

export function useUpdateTicket(ticketId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { status?: string; priority?: string; category?: string; assignedToUserId?: string | null; subject?: string }) =>
      updateTicket({ id: ticketId, ...input }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ticket', ticketId] }),
  })
}
