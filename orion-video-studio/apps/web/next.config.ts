import type { NextConfig } from 'next'

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000'

const config: NextConfig = {
  transpilePackages: ['@orion/shared', '@orion/timeline', '@orion/ui'],
  // o navegador fala apenas com a mesma origem; /api é encaminhado à API
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }]
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
        ],
      },
    ]
  },
}

export default config
