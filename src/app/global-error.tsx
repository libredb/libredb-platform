'use client'

import { Button } from '@/shared/components/ui/button'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html>
      <body>
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-bold">Something went wrong</h2>
            <p className="mt-2 text-muted-foreground">{error.message}</p>
            <Button onClick={reset} className="mt-4">
              Try again
            </Button>
          </div>
        </div>
      </body>
    </html>
  )
}
