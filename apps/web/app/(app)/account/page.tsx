'use client';
import { Button, Card, ErrorBox, Input, PageHeader } from '@erp/ui';
import { useEffect, useState } from 'react';
import { api, openDoc } from '@/lib/api';
import { useMeta } from '@/lib/meta';
import { RefPicker } from '@/lib/RefPicker';

interface Session { familyId: string; ip?: string; userAgent?: string; createdAt: string }

export default function Account() {
  const meta = useMeta();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<unknown>(null);
  const [prefs, setPrefs] = useState<{ notifyEmail: boolean; notifySms: boolean; delegateToId: string | null; delegateUntil: string | null } | null>(null);
  const load = () => api<Session[]>('auth/sessions').then(setSessions).catch(setMsg);
  useEffect(() => { load(); api<typeof prefs>('auth/preferences').then(setPrefs); }, []);
  const savePrefs = (p: Partial<NonNullable<typeof prefs>>) => api('auth/preferences', 'POST', p).then(() => api<typeof prefs>('auth/preferences').then(setPrefs)).catch(setMsg);
  return (
    <>
      <PageHeader title="My account" subtitle={meta.user.name} actions={meta.user.employeeId && <Button variant="outline" onClick={() => openDoc(`finance/statement/employee/${meta.user.employeeId}?format=html`)}>My account statement</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChangePassword />
        <Card title="Two-factor authentication">
          {!setup ? <Button onClick={() => api<typeof setup>('auth/2fa/setup', 'POST').then(setSetup).catch(setMsg)}>Set up authenticator app</Button> : (
            <div className="space-y-2 text-sm">
              <p>Add this key to Google Authenticator / Authy, then enter the 6-digit code.</p>
              <code className="block break-all rounded bg-muted p-2">{setup.secret}</code>
              <div className="flex gap-2">
                <Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" />
                <Button onClick={() => api('auth/2fa/enable', 'POST', { code }).then(() => { setMsg('Two-factor enabled.'); setSetup(null); }).catch(setMsg)}>Enable</Button>
              </div>
            </div>
          )}
          <div className="mt-3"><ErrorBox error={msg} /></div>
        </Card>
        {prefs && (
          <Card title="Notifications & delegation">
            <label className="flex items-center gap-2 text-sm"><Input type="checkbox" checked={prefs.notifyEmail} onChange={(e) => savePrefs({ notifyEmail: e.target.checked })} /> Also email me my notifications</label>
            <label className="mt-2 flex items-center gap-2 text-sm"><Input type="checkbox" checked={prefs.notifySms} onChange={(e) => savePrefs({ notifySms: e.target.checked })} /> Also SMS / WhatsApp (phone from my employee profile)</label>
            <div className="mt-4 space-y-2 text-sm">
              <p className="text-muted-foreground">On leave? Route your approvals to a colleague until a date.</p>
              {meta.resources.some((r) => r.key === 'core.user') ? (
                <RefPicker f={{ name: 'delegateToId', type: 'string', ref: 'core.user' }} value={prefs.delegateToId} onChange={(v) => setPrefs({ ...prefs, delegateToId: (v as string) ?? null })} />
              ) : <p className="text-xs">Ask an admin to set a delegate.</p>}
              <Input type="date" aria-label="Delegate until" value={prefs.delegateUntil?.slice(0, 10) ?? ''} onChange={(e) => setPrefs({ ...prefs, delegateUntil: e.target.value || null })} />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => savePrefs({ delegateToId: prefs.delegateToId, delegateUntil: prefs.delegateUntil ? `${prefs.delegateUntil.slice(0, 10)}T23:59:59` : null })}>Save delegation</Button>
                {prefs.delegateToId && <Button size="sm" variant="ghost" onClick={() => savePrefs({ delegateToId: null })}>Stop delegating</Button>}
              </div>
            </div>
          </Card>
        )}
        <Card title="Signed-in devices">
          <ul className="divide-y divide-border text-sm">
            {sessions.map((s) => (
              <li key={s.familyId} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0"><span className="block truncate">{s.userAgent ?? 'Unknown device'}</span><span className="text-xs text-muted-foreground">{s.ip} · {new Date(s.createdAt).toLocaleString()}</span></span>
                <Button variant="ghost" size="sm" onClick={() => api(`auth/sessions/${s.familyId}`, 'DELETE').then(load)}>Sign out</Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

/** Your own password: current one first; other devices are signed out. */
function ChangePassword() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const mismatch = f.again !== '' && f.next !== f.again;
  const save = async () => {
    setBusy(true); setMsg(null); setDone(false);
    try {
      await api('auth/password', 'POST', { current: f.current, next: f.next });
      setF({ current: '', next: '', again: '' }); setDone(true);
      try { sessionStorage.removeItem('erp.mustChangePassword'); } catch { /* storage off */ }
    } catch (e) { setMsg(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Change password">
      <div className="space-y-3 text-sm">
        <ErrorBox error={msg} />
        {done && <p role="status" style={{ color: 'var(--tone-green)' }}>Password changed. Your other devices have been signed out.</p>}
        <label className="block"><span className="mb-1 block text-xs text-muted-foreground">Current password</span><Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
        <label className="block"><span className="mb-1 block text-xs text-muted-foreground">New password</span><Input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></label>
        <label className="block"><span className="mb-1 block text-xs text-muted-foreground">New password again</span><Input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></label>
        {mismatch && <p className="text-xs" style={{ color: 'var(--tone-red)' }}>The two new passwords don&apos;t match.</p>}
        <Button disabled={busy || !f.current || !f.next || f.next !== f.again} onClick={save}>{busy ? 'Saving…' : 'Change password'}</Button>
      </div>
    </Card>
  );
}
