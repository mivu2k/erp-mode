import type { NextConfig } from 'next';
import path from 'node:path';

// The monorepo root, set explicitly: Next refuses to infer it when it is also a home directory (e.g. /opt/erp for an `erp` user).
const root = path.join(__dirname, '../..');

const config: NextConfig = {
  transpilePackages: ['@erp/ui'],
  // Same-origin API: refresh-token cookie stays first-party, no CORS in the browser.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/:path*` }];
  },
  output: 'standalone',
  turbopack: { root },
  outputFileTracingRoot: root,
};
export default config;
