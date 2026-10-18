'use client'

import { useState } from 'react'
import { CheckIcon, StarIcon } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Textarea } from '@/shared/components/ui/textarea'
import { useAction } from '@/shared/hooks/use-action'
import { submitCsat } from '../actions/submit-csat'

export function CsatPrompt({ ticketId }: { ticketId: string }) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const { execute, isPending } = useAction(submitCsat, {
    successMessage: 'Thank you!',
    onSuccess: () => setSubmitted(true),
  })

  if (submitted) {
    return <div className="flex items-center justify-center gap-1.5 rounded-md border bg-card p-4 text-sm"><CheckIcon className="size-4" aria-hidden /> Thank you for your rating.</div>
  }

  return (
    <div className="rounded-md border bg-card p-4 space-y-3">
      <div className="font-medium">Your ticket has been resolved. How did it go?</div>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            className={`rounded p-1 transition-colors ${n <= rating ? 'text-amber-500' : 'text-muted-foreground hover:text-amber-400'}`}
            aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
          >
            <StarIcon className="size-6" fill={n <= rating ? 'currentColor' : 'none'} />
          </button>
        ))}
      </div>
      <Textarea
        placeholder="Your comment (optional)"
        value={comment}
        onChange={e => setComment(e.target.value)}
        maxLength={1000}
      />
      <Button
        disabled={rating === 0 || isPending}
        onClick={() => execute({ ticketId, rating, comment: comment.trim() || undefined })}
      >
        Send
      </Button>
    </div>
  )
}
