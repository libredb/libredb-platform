'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { z } from 'zod'
import { SupportRepository } from '../lib/support.repository'

const schema = z.object({ q: z.string().max(60).default('') })

export const searchPlatformStaff = safeAction(
  'searchPlatformStaff',
  schema,
  async (input) => {
    if (!input.q || input.q.length < 1) return []
    return SupportRepository.searchPlatformStaff(input.q)
  },
)
