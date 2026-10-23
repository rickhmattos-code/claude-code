import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: ['@orion/shared', '@orion/timeline', '@orion/ui'],
  // o navegador fala apenas com a mesma origem; /api é encaminhado à API por
  // src/app/api/[...path]/route.ts (endereço lido em tempo de execução)
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
