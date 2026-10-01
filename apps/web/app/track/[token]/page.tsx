'use client';
import { Card, StatusBadge, ThemeProvider } from '@erp/ui';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Track { number: string; status: string; brand?: string; model?: string; expectedAt?: string; updatedAt: string; company?: { name: string; phone?: string } }

/** Public job status page (QR on the intake receipt). */
export default function TrackPage() {
  const { token } = useParams<{ token: string }>();
  const [t, setT] = useState<Track | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { fetch(`/api/public/track/${token}`).then((r) => (r.ok ? r.json() : Promise.reject())).then(setT).catch(() => setErr(true)); }, [token]);
  return (
    <ThemeProvider>
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm" title={t?.company?.name ?? 'Repair status'}>
          {err && <p className="text-sm">Job not found.</p>}
          {t && (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Job</dt><dd className="font-medium">{t.number}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Device</dt><dd>{[t.brand, t.model].filter(Boolean).join(' ') || '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Status</dt><dd><StatusBadge status={t.status} /></dd></div>
              {t.expectedAt && <div className="flex justify-between"><dt className="text-muted-foreground">Expected</dt><dd>{new Date(t.expectedAt).toLocaleDateString()}</dd></div>}
              <div className="flex justify-between"><dt className="text-muted-foreground">Updated</dt><dd>{new Date(t.updatedAt).toLocaleString()}</dd></div>
              {t.company?.phone && <p className="pt-2 text-xs text-muted-foreground">Questions? Call {t.company.phone}</p>}
            </dl>
          )}
        </Card>
      </main>
    </ThemeProvider>
  );
}
