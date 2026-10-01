import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@erp/ui'],
  // Same-origin API: refresh-token cookie stays first-party, no CORS in the browser.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/:path*` }];
  },
  output: 'standalone',
};
export default config;
