'use client'

import { useState } from 'react'
import { CopyIcon, CheckIcon } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'

interface InvitationCopyLinkProps {
  token: string
}

export function InvitationCopyLink({ token }: InvitationCopyLinkProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    const url = `${window.location.origin}/invite/${token}`
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button variant="ghost" size="icon-sm" onClick={handleCopy}>
      {copied ? (
        <CheckIcon className="size-4 text-green-600" />
      ) : (
        <CopyIcon className="size-4" />
      )}
      <span className="sr-only">Copy invite link</span>
    </Button>
  )
}
