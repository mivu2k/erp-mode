'use client';
import { Button, Card, ErrorBox, Input, Label, ThemeProvider } from '@erp/ui';
import { FormEvent, Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

function Reset() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api('auth/reset', 'POST', { token, password }); setDone(true); } catch (err) { setMsg(err); }
  }
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm" title="Choose a new password">
        {done ? <p className="text-sm">Password changed. <a className="text-primary underline" href="/login">Sign in</a></p> : (
          <form onSubmit={submit} className="space-y-3">
            <div><Label htmlFor="pw">New password (8+ chars, upper, lower, digit)</Label><Input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
            <ErrorBox error={msg} />
            <Button className="w-full">Save</Button>
          </form>
        )}
      </Card>
    </main>
  );
}
export default function Page() { return <ThemeProvider><Suspense><Reset /></Suspense></ThemeProvider>; }
