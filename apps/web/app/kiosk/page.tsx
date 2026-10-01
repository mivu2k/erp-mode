'use client';
import { Button, Card, ErrorBox, Input, Label, ThemeProvider } from '@erp/ui';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

interface Punch { nfcUid?: string; qrToken?: string; at: string; idempotencyKey: string }
const ls = {
  get<T>(k: string, d: T): T { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

/**
 * Attendance kiosk (tablet/phone, full screen). Works with USB NFC readers (keyboard wedge), Web NFC on Android,
 * camera QR via BarcodeDetector, and shows a rotating QR for app-based check-in. Punches queue offline and sync later.
 */
export default function Kiosk() {
  const [token, setTokenState] = useState<string | null>(null);
  const [station, setStation] = useState<{ name: string; methods: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [queue, setQueue] = useState<Punch[]>([]);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const wedge = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => { setTokenState(ls.get('kiosk:token', null)); setStation(ls.get('kiosk:station', null)); setQueue(ls.get('kiosk:queue', [])); }, []);
  useEffect(() => ls.set('kiosk:queue', queue), [queue]);

  const headers = useCallback(() => ({ 'Content-Type': 'application/json', 'x-device-token': token ?? '' }), [token]);

  const send = useCallback(async (p: Punch) => {
    const r = await fetch('/api/hrm/kiosk/punch', { method: 'POST', headers: headers(), body: JSON.stringify(p) });
    if (r.status >= 500 || r.status === 0) throw new Error('offline');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, text: body.message ?? 'Not recognised' };
    return { ok: true, text: `${body.employee.name} — ${new Date(body.at).toLocaleTimeString()}` };
  }, [headers]);

  const punch = useCallback(async (p: Omit<Punch, 'at' | 'idempotencyKey'>) => {
    const full = { ...p, at: new Date().toISOString(), idempotencyKey: crypto.randomUUID() };
    try { setFlash(await send(full)); } catch { setQueue((q) => [...q, full]); setFlash({ ok: true, text: 'Saved offline — will sync' }); }
    setTimeout(() => setFlash(null), 3000);
  }, [send]);

  // Offline queue flush.
  useEffect(() => {
    if (!token) return;
    const t = setInterval(async () => {
      const q: Punch[] = ls.get('kiosk:queue', []);
      if (!q.length) return;
      const left: Punch[] = [];
      for (const p of q) { try { await send(p); } catch { left.push(p); } }
      setQueue(left);
    }, 10_000);
    return () => clearInterval(t);
  }, [token, send]);

  // Rotating QR for app scan.
  useEffect(() => {
    if (!token || !station?.methods.includes('rotating_qr')) return;
    let t: ReturnType<typeof setTimeout>;
    const load = async () => {
      const r = await fetch('/api/hrm/kiosk/qr', { headers: headers() }).catch(() => null);
      const d = r?.ok ? await r.json() : null;
      setQr(d?.svg ?? null);
      t = setTimeout(load, ((d?.refreshInSec ?? 30) - 2) * 1000);
    };
    load();
    return () => clearTimeout(t);
  }, [token, station, headers]);

  // Web NFC (Android Chrome); USB readers type into the hidden input instead.
  useEffect(() => {
    if (!token) return;
    const NDEF = (window as unknown as { NDEFReader?: new () => { scan(): Promise<void>; onreading: (e: { serialNumber: string }) => void } }).NDEFReader;
    if (!NDEF) return;
    const r = new NDEF();
    r.scan().then(() => { r.onreading = (e) => punch({ nfcUid: e.serialNumber }); }).catch(() => {});
  }, [token, punch]);

  // Camera: employee shows personal QR.
  useEffect(() => {
    if (!token || !station?.methods.includes('qr')) return;
    const Det = (window as unknown as { BarcodeDetector?: new (o?: object) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!Det) return;
    let live = true;
    let stream: MediaStream | null = null;
    let last = '';
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user' } }).then(async (s) => {
      stream = s;
      if (!video.current) return;
      video.current.srcObject = s;
      await video.current.play();
      const det = new Det({ formats: ['qr_code'] });
      while (live) {
        const [c] = await det.detect(video.current).catch(() => []);
        if (c && c.rawValue !== last) { last = c.rawValue; punch({ qrToken: c.rawValue }); setTimeout(() => { last = ''; }, 5000); }
        await new Promise((res) => setTimeout(res, 300));
      }
    }).catch(() => {});
    return () => { live = false; stream?.getTracks().forEach((x) => x.stop()); };
  }, [token, station, punch]);

  useEffect(() => { const t = setInterval(() => wedge.current?.focus(), 1000); return () => clearInterval(t); }, []);

  // Opened from a pairing link (/kiosk?code=123456): pair straight away, then drop the code from the address bar.
  useEffect(() => {
    const c = new URLSearchParams(location.search).get('code');
    if (!c || ls.get('kiosk:token', null)) return;
    history.replaceState(null, '', '/kiosk');
    setCode(c);
    pairWith(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pair(e: FormEvent) {
    e.preventDefault();
    await pairWith(code);
  }

  async function pairWith(code: string) {
    setError(null);
    const r = await fetch('/api/hrm/kiosk/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (!r.ok) return setError(d.message ?? 'Pairing failed');
    ls.set('kiosk:token', d.deviceToken);
    ls.set('kiosk:station', d.station);
    setTokenState(d.deviceToken);
    setStation(d.station);
    document.documentElement.requestFullscreen?.().catch(() => {});
  }

  if (!token) return (
    <ThemeProvider>
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm" title="Pair this kiosk">
          <form onSubmit={pair} className="space-y-3">
            <p className="text-sm text-muted-foreground">Easiest: open the pairing link (or scan its QR) from HR › Kiosk Stations › “Pair a device” on this device. Or type the 6-digit code:</p>
            <div><Label htmlFor="code">Pairing code</Label><Input id="code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></div>
            <ErrorBox error={error} />
            <Button className="w-full">Pair</Button>
          </form>
        </Card>
      </main>
    </ThemeProvider>
  );

  return (
    <ThemeProvider>
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
        <h1 className="text-2xl font-semibold">{station?.name}</h1>
        <p className="text-5xl font-light tabular-nums"><Clock /></p>
        <form onSubmit={(e) => { e.preventDefault(); const v = wedge.current!.value.trim(); wedge.current!.value = ''; if (v) punch({ nfcUid: v }); }}>
          <input ref={wedge} aria-label="Card reader input" className="sr-only" autoFocus autoComplete="off" />
        </form>
        <div className={`min-h-16 rounded-xl px-8 py-4 text-xl font-medium ${flash ? '' : 'invisible'}`}
          style={{ color: `var(--tone-${flash?.ok ? 'green' : 'red'})`, background: `var(--tone-${flash?.ok ? 'green' : 'red'}-bg)` }} role="status" aria-live="assertive">
          {flash?.text ?? '—'}
        </div>
        <p className="text-muted-foreground">Tap your card{station?.methods.includes('qr') ? ' or show your QR' : ''}</p>
        <div className="flex flex-wrap items-center justify-center gap-6">
          {qr && <div className="rounded-xl bg-white p-3" style={{ width: 220 }} dangerouslySetInnerHTML={{ __html: qr }} aria-label="Scan with the ERP app to check in" />}
          <video ref={video} className="h-40 rounded-xl" muted playsInline />
        </div>
        {queue.length > 0 && <p className="text-xs" style={{ color: 'var(--tone-amber)' }}>{queue.length} punch(es) waiting to sync</p>}
        <button className="fixed bottom-2 end-2 text-xs text-muted-foreground opacity-40" onClick={() => { if (confirm('Unpair this device?')) { localStorage.removeItem('kiosk:token'); location.reload(); } }}>unpair</button>
      </main>
    </ThemeProvider>
  );
}

function Clock() {
  const [now, setNow] = useState('');
  useEffect(() => { const f = () => setNow(new Date().toLocaleTimeString()); f(); const t = setInterval(f, 1000); return () => clearInterval(t); }, []);
  return <>{now}</>;
}
