'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import type { Result } from '@/shared/types'

export function useAction<TInput, TOutput>(
  action: (input: TInput) => Promise<Result<TOutput>>,
  options?: {
    onSuccess?: (data: TOutput) => void
    onError?: (error: string) => void
    successMessage?: string
  },
) {
  const [isPending, startTransition] = useTransition()

  const execute = (input: TInput) => {
    startTransition(async () => {
      const result = await action(input)
      if (result.success) {
        if (options?.successMessage) toast.success(options.successMessage)
        options?.onSuccess?.(result.data)
      } else {
        toast.error(result.error)
        options?.onError?.(result.error)
      }
    })
  }

  return { execute, isPending }
}
