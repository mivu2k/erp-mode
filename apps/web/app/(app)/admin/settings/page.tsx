'use client';
import { Button, Card, ErrorBox, PageHeader, Textarea } from '@erp/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Every tunable business rule (system accounts, payroll rules, job transitions, limits). */
export default function Settings() {
  const [s, setS] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, unknown>>({});
  useEffect(() => { api<Record<string, unknown>>('admin/settings').then((d) => setS(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, JSON.stringify(v, null, 2)])))); }, []);
  const save = async (k: string) => {
    try { await api(`admin/settings/${k}`, 'PUT', { value: JSON.parse(s[k]) }); setMsg((m) => ({ ...m, [k]: 'Saved' })); } catch (e) { setMsg((m) => ({ ...m, [k]: e })); }
  };
  return (
    <>
      <PageHeader title="System settings" />
      <div className="grid gap-4 lg:grid-cols-2">
        {Object.keys(s).map((k) => (
          <Card key={k} title={k} actions={<Button size="sm" onClick={() => save(k)}>Save</Button>}>
            <Textarea className="font-mono text-xs" rows={Math.min(16, s[k].split('\n').length + 1)} value={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.value })} aria-label={k} />
            <div className="mt-2"><ErrorBox error={msg[k] === 'Saved' ? null : msg[k]} />{msg[k] === 'Saved' && <span className="text-xs text-muted-foreground">Saved</span>}</div>
          </Card>
        ))}
      </div>
    </>
  );
}
