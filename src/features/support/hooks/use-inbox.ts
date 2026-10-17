'use client'

import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'

async function fetchInbox(params: string) {
  const res = await fetch(`/support/api/inbox?${params}`)
  if (!res.ok) throw new Error('fetch-failed')
  return res.json()
}

export function useInbox() {
  const sp = useSearchParams()
  const params = sp.toString()
  return useQuery({
    queryKey: ['inbox', params],
    queryFn: () => fetchInbox(params),
    refetchInterval: (q) => q.state.error ? false : 15_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
}
