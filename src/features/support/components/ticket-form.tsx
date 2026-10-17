'use client'

import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { useAction } from '@/shared/hooks/use-action'
import { createTicket } from '../actions/create-ticket'
import { createTicketSchema, type CreateTicketData } from '../lib/support.schema'
import { ReplyComposer } from './reply-composer'

interface TicketFormProps {
  /** Called with the new ticket's id after a successful create. */
  onDone?: (ticketId: string) => void
  /** Called when the user dismisses the form without submitting. Separate
   *  from `onDone` so callers can distinguish success from cancellation. */
  onCancel?: () => void
}

/**
 * Single-submit-path ticket creation form.
 *
 * The ReplyComposer's own Send button is the ONLY submit path: it supplies
 * the rich body + attachments directly into the create action, alongside
 * subject/priority/category captured by the outer react-hook-form. There is
 * no wrapping `<form onSubmit>` and no second "Create ticket" button.
 * Previously the pair could fire independently, causing empty-description
 * submits and double-execute races.
 */
export function TicketForm({ onDone, onCancel }: TicketFormProps) {
  const router = useRouter()

  const form = useForm<CreateTicketData>({
    resolver: zodResolver(createTicketSchema) as never,
    defaultValues: {
      subject: '',
      descriptionRich: '',
      descriptionPlain: '',
      priority: 'MEDIUM',
      category: 'GENERAL',
    },
  })

  const { execute, isPending } = useAction(createTicket, {
    successMessage: 'Ticket created',
    onSuccess: (ticket: { id: string }) => {
      if (onDone) onDone(ticket.id)
      else router.push(`/support/${ticket.id}`)
    },
  })

  const handleCancel = () => {
    if (onCancel) onCancel()
    else router.push('/support')
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="subject">Subject</Label>
        <Input id="subject" placeholder="Short summary" {...form.register('subject')} />
        {form.formState.errors.subject && (
          <p className="mt-1 text-xs text-destructive">
            {form.formState.errors.subject.message}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Priority</Label>
          <Select defaultValue="MEDIUM" onValueChange={v => { if (v) form.setValue('priority', v) }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Category</Label>
          <Select defaultValue="GENERAL" onValueChange={v => { if (v) form.setValue('category', v) }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {['GENERAL', 'BILLING', 'TECHNICAL'].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Description</Label>
        <ReplyComposer
          placeholder="Describe your issue in detail…"
          allowInternalToggle={false}
          isPending={isPending}
          onSend={async (payload) => {
            // Run react-hook-form / zod validation before submitting. This
            // catches schema rules (e.g. subject.min(5)) on the client and
            // populates form.formState.errors for inline field feedback
            // instead of failing silently on the server action.
            form.setValue('descriptionRich', payload.bodyRich)
            form.setValue('descriptionPlain', payload.bodyPlain)
            const isValid = await form.trigger()
            if (!isValid) {
              const firstError = Object.values(form.formState.errors)[0]
              if (firstError?.message) toast.error(String(firstError.message))
              return
            }
            const data = form.getValues()
            execute({
              subject: data.subject,
              descriptionRich: payload.bodyRich,
              descriptionPlain: payload.bodyPlain,
              priority: data.priority,
              category: data.category,
              attachments: payload.attachments,
            })
          }}
        />
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={handleCancel}>Cancel</Button>
      </div>
    </div>
  )
}
