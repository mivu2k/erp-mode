'use client';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

export interface Branding { primary?: string; secondary?: string; font?: string; mode?: 'light' | 'dark'; density?: 'compact' | 'comfortable'; logo?: string; logoDark?: string }

const Ctx = createContext<{ mode: 'light' | 'dark'; toggle(): void; branding: Branding }>({ mode: 'light', toggle() {}, branding: {} });
export const useTheme = () => useContext(Ctx);

/** The single styling controller: applies company branding + user light/dark choice as CSS variables. */
export function ThemeProvider({ branding = {}, children }: { branding?: Branding; children: ReactNode }) {
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('theme'); } catch { /* storage blocked */ }
    setMode((saved as 'light' | 'dark') ?? branding.mode ?? 'dark');
  }, [branding.mode]);
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('dark', mode === 'dark');
    if (branding.primary) el.style.setProperty('--primary', branding.primary);
    if (branding.secondary) el.style.setProperty('--secondary', branding.secondary);
    if (branding.font) el.style.setProperty('--font', `'${branding.font}', ui-sans-serif, system-ui, sans-serif`);
    el.style.setProperty('--density', branding.density === 'compact' ? '0.8' : '1');
  }, [mode, branding]);
  const toggle = () => setMode((m) => {
    const next = m === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', next); } catch { /* storage blocked */ }
    return next;
  });
  return <Ctx.Provider value={{ mode, toggle, branding }}>{children}</Ctx.Provider>;
}

/** Central status → colour mapping used by every module. Unknown statuses fall back to gray. */
export const STATUS_TONE: Record<string, string> = {
  draft: 'gray', todo: 'gray', open: 'blue', received: 'blue', pending: 'amber', submitted: 'amber', review: 'violet', sent: 'violet', quotation_sent: 'violet',
  approved: 'green', accepted: 'green', active: 'green', present: 'green', paid: 'green', settled: 'green', posted: 'green', done: 'green', completed: 'green', delivered: 'green', closed: 'gray', returned: 'green', converted: 'green', ready: 'green',
  rejected: 'red', declined: 'red', cancelled: 'red', overdue: 'red', absent: 'red', blocked: 'red', terminated: 'red', not_repairable: 'red',
  in_progress: 'blue', in_repair: 'blue', assigned: 'blue', diagnosing: 'blue', diagnosed: 'violet', qc: 'violet', disbursed: 'blue', out: 'amber', partially_paid: 'amber', partially_received: 'amber', partially_returned: 'amber', parts_pending: 'amber', late: 'amber', half_day: 'amber', unpaid: 'amber', on_leave: 'amber', leave: 'violet', holiday: 'violet', weekend: 'gray', in_maintenance: 'amber',
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  const tone = STATUS_TONE[status] ?? 'gray';
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap" style={{ color: `var(--tone-${tone})`, background: `var(--tone-${tone}-bg)` }}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
