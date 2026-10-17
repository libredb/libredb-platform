'use client'

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        <div className="text-lg font-medium">Something went wrong</div>
        <div className="text-sm text-muted-foreground">{error.message}</div>
        <button
          onClick={reset}
          className="rounded border border-border px-3 py-1 text-sm transition-colors hover:bg-accent"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
