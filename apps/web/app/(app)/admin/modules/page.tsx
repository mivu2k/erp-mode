'use client';
import { Card, PageHeader } from '@erp/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function Modules() {
  const [mods, setMods] = useState<{ key: string; label: string; enabled: boolean }[]>([]);
  const load = () => api<typeof mods>('admin/modules').then(setMods);
  useEffect(() => { load(); }, []);
  return (
    <>
      <PageHeader title="Modules & add-ons" subtitle="Disabled modules disappear from menus and their APIs return 403." />
      <Card>
        <ul className="divide-y divide-border">
          {mods.map((m) => (
            <li key={m.key} className="flex items-center justify-between py-2 text-sm">
              <span>{m.label} <span className="text-xs text-muted-foreground">({m.key})</span></span>
              <label className="flex items-center gap-2">
                <input type="checkbox" role="switch" disabled={m.key === 'core'} checked={m.enabled} onChange={(e) => api(`admin/modules/${m.key}`, 'PUT', { enabled: e.target.checked }).then(load)} />
                {m.enabled ? 'Enabled' : 'Disabled'}
              </label>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
