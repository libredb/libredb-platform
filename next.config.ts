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
}

export default nextConfig
