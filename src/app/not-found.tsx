import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h2 className="text-4xl font-bold">404</h2>
        <p className="mt-2 text-muted-foreground">Page not found</p>
        <Link href="/" className="mt-4 inline-block text-primary underline">Go home</Link>
      </div>
    </div>
  )
}
