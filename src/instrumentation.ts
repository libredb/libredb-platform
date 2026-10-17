/**
 * Runs once when a Next.js server starts, before it serves a request; `next build` never calls it.
 * Next.js also compiles this file for the Edge runtime, so Node.js-only code lives in instrumentation-node.ts
 * and is imported only on the Node.js runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeRuntime } = await import('./instrumentation-node')
    registerNodeRuntime()
  }
}
