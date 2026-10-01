import type { Metadata, Viewport } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = { title: 'ERP', description: 'Modular enterprise ERP' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2563eb' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body className="min-h-screen antialiased"><Providers>{children}</Providers></body>
    </html>
  );
}
