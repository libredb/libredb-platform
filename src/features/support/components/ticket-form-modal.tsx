'use client'

import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import { TicketForm } from './ticket-form'

export function TicketFormModal() {
  const router = useRouter()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) router.back() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>New Ticket</DialogTitle></DialogHeader>
        <TicketForm onDone={() => router.back()} onCancel={() => router.back()} />
      </DialogContent>
    </Dialog>
  )
}
