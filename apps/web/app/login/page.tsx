'use client';
import { Button, Card, ErrorBox, Input, Label, ThemeProvider } from '@erp/ui';
import { FormEvent, Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, setToken } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next') ?? '/';
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (forgot) {
        await api('auth/forgot', 'POST', { email: login });
        setError('If that email exists, a reset link has been sent.');
        return;
      }
      const r = await api<{ accessToken?: string; twoFactorRequired?: boolean }>('auth/login', 'POST', { login, password, ...(otp !== null ? { otp } : {}) });
      if (r.twoFactorRequired) return setOtp('');
      setToken(r.accessToken!);
      router.replace(next.startsWith('/') ? next : '/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm" title={forgot ? 'Reset password' : 'Sign in'}>
        <form onSubmit={submit} className="space-y-3">
          <div><Label htmlFor="login">{forgot ? 'Email' : 'Email or username'}</Label><Input id="login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required autoFocus /></div>
          {!forgot && <div><Label htmlFor="pw">Password</Label><Input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>}
          {otp !== null && <div><Label htmlFor="otp">Authenticator code</Label><Input id="otp" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} required /></div>}
          <ErrorBox error={error} />
          <Button className="w-full" disabled={busy}>{busy ? '…' : forgot ? 'Send reset link' : 'Sign in'}</Button>
          <button type="button" className="w-full text-center text-xs text-muted-foreground hover:underline" onClick={() => { setForgot((f) => !f); setError(null); }}>
            {forgot ? 'Back to sign in' : 'Forgot password?'}
          </button>
        </form>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return <ThemeProvider><Suspense><LoginForm /></Suspense></ThemeProvider>;
}
