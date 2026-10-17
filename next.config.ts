import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['sharp', 'pg'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  images: {
    // The app renders no next/image, so the image optimizer is off and /_next/image answers 404.
    unoptimized: true,
  },
  // `next dev` run by a coding agent would replace the managed block of AGENTS.md with Next.js's own text, which holds
  // em dashes; AGENTS.md keeps the repository's wording.
  agentRules: false,
}

export default nextConfig
