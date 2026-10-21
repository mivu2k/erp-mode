'use client';
import { Button, cx, Dialog, I18nProvider, Icon, Input, Skeleton, ThemeProvider, useT, useTheme } from '@erp/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { barcodeDetector } from '@/lib/scan';
import { api, getToken, hasToken, qs, refresh, setToken } from '@/lib/api';
import { can, Meta, MetaProvider, useMeta, useMetaQuery } from '@/lib/meta';

interface Hit { entityType: string; entityId: string; title: string; subtitle?: string | null; module?: string }

export default function AppLayout({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const router = useRouter();
  useEffect(() => {
    (hasToken() ? Promise.resolve(true) : refresh()).then((ok) => (ok ? setReady(true) : router.replace(`/login?next=${encodeURIComponent(location.pathname)}`)));
  }, [router]);
  const meta = useMetaQuery(ready);
  if (!meta.data) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  return (
    <MetaProvider meta={meta.data}>
      <ThemeProvider branding={meta.data.company.branding ?? {}}>
        <I18nProvider locale={meta.data.user.locale ?? 'en'}>
          <Shell>{children}</Shell>
        </I18nProvider>
      </ThemeProvider>
    </MetaProvider>
  );
}

/** Screens staff use for themselves; everything else in a module is management/admin. */
const EMPLOYEE_SCREENS = new Set(['hrm.leave', 'hrm.correction', 'hrm.attendance', 'hrm.punch', 'hrm.payslip', 'hrm.task', 'hrm.dailyreport', 'finance.advance', 'finance.loan', 'finance.claim'].map((k) => `/r/${k}`));

function menu(meta: Meta) {
  const groups = new Map<string, { href: string; label: string }[]>();
  const add = (g: string, href: string, label: string) => groups.set(g, [...(groups.get(g) ?? []), { href, label }]);
  if (can(meta, 'repair.dashboard.view')) add('repair', '/repair/dashboard', 'Dashboard');
  if (can(meta, 'fleet.dashboard.view')) add('fleet', '/fleet/dashboard', 'Dashboard');
  if (can(meta, 'hrm.payroll.create')) add('hrm', '/hrm/payroll', 'Run payroll');
  if (can(meta, 'hrm.attendance.manage')) add('hrm', '/hrm/attendance', 'Process attendance');
  if (can(meta, 'catalog.item.print')) add('catalog', '/catalog/builder', 'Brochure & deck builder');
  if (can(meta, 'catalog.item.update')) add('catalog', '/catalog/profile', 'Company profile');
  if (can(meta, 'payables.due.view')) add('payables', '/payables', 'Timeline');
  if (can(meta, 'utilities.connection.view')) add('utilities', '/utilities', 'Tracker');
  if (can(meta, 'payables.due.create')) { add('payables', '/r/payables.due/new?direction=receivable', 'Add receivable'); add('payables', '/r/payables.due/new?direction=payable', 'Add payable'); }
  if (can(meta, 'finance.report.view')) add('finance', '/finance/reports', 'Financial reports');
  // Products and repair spare parts are one item list, split by kind: each gets its own menu entry.
  const href = (k: string) => (k === 'finance.account' ? '/finance/accounts' : k === 'core.masterdata' ? '/admin/lists' : k === 'core.setting' ? '/admin/settings' : k === 'serials.item' ? '/serials' : k === 'inventory.product' ? '/r/inventory.product?kind=product' : `/r/${k}`);
  for (const r of meta.resources) add(r.group ?? r.key.split('.')[0], href(r.key), r.label);
  // Spare parts are inventory: their list and the store's parts desk (issue to / receive from repair jobs) live there.
  if (can(meta, 'inventory.product.view')) add('inventory', '/r/inventory.product?kind=part', 'Spare parts');
  if (can(meta, 'inventory.movement.create')) add('inventory', '/inventory/parts-desk', 'Parts desk');
  add('reports', '/reports', 'Reports'); // standard library lists only reports on data the user can see
  if (can(meta, 'reports.dashboard.view')) add('reports', '/dashboards', 'Dashboard builder');
  if (can(meta, 'core.role.manage')) add('core', '/admin/roles', 'Roles & permissions');
  if (can(meta, 'core.module.view')) add('core', '/admin/modules', 'Modules');
  if (can(meta, 'core.company.update')) add('core', '/admin/branding', 'Branding');
  if (can(meta, 'core.setting.view')) add('core', '/admin/jobs', 'Background jobs');
  return meta.modules.filter((m) => groups.has(m.key)).map((m) => ({ ...m, items: groups.get(m.key)! }));
}

function Shell({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const path = usePathname();
  const router = useRouter();
  const { mode, toggle, branding } = useTheme();
  const t = useT();
  const qc = useQueryClient();
  const setLocale = (locale: string) => api('auth/preferences', 'POST', { locale }).then(() => qc.invalidateQueries({ queryKey: ['meta'] }));
  const [nav, setNav] = useState(false);
  const [search, setSearch] = useState(false);
  const [notes, setNotes] = useState<{ items: { id: string; title: string; body?: string; link?: string; readAt?: string; createdAt: string }[]; unread: number }>({ items: [], unread: 0 });
  const [showNotes, setShowNotes] = useState(false);
  const groups = useMemo(() => menu(meta), [meta]);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // Live notifications over SSE; on error (e.g. expired token) refresh and reconnect. A slow poll is the safety net.
  useEffect(() => {
    const load = () => api<typeof notes>('notifications').then(setNotes).catch(() => {});
    load();
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(getToken() ?? '')}`);
      es.onmessage = load;
      es.onerror = () => {
        es?.close();
        retry = setTimeout(() => refresh().finally(connect), 5_000);
      };
    };
    connect();
    const t = setInterval(load, 5 * 60_000);
    return () => { es?.close(); clearTimeout(retry); clearInterval(t); };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(true); } };
    // Other screens (e.g. My HR › Check in at a kiosk) open the scanner with this event.
    const open = () => setSearch(true);
    window.addEventListener('erp:scan', open);
    addEventListener('keydown', k);
    return () => { removeEventListener('keydown', k); window.removeEventListener('erp:scan', open); };
  }, []);
  useEffect(() => setNav(false), [path]);

  const logout = async () => { await api('auth/logout', 'POST').catch(() => {}); setToken(null); location.href = '/login'; };

  const item = (active: boolean) => cx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors', active ? 'bg-[var(--sidebar-active)] text-white' : 'hover:bg-[var(--sidebar-hover)] hover:text-white');
  const initials = meta.user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const sidebar = (
    <div className="flex h-full flex-col bg-[var(--sidebar)] text-[var(--sidebar-foreground)]">
      <Link href="/" className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/5 px-4 font-semibold text-white">
        {branding.logoDark || branding.logo
          ? <img src={branding.logoDark ?? branding.logo} alt="" className="h-7" />
          : <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-sm text-primary-foreground">{meta.company.name[0]}</span>}
        <span className="truncate">{meta.company.name}</span>
      </Link>
      <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto p-3 text-sm">
        <Link href="/" className={item(path === '/')}><Icon name="home" />{t('Dashboard')}</Link>
        <Link href="/approvals" className={item(path === '/approvals')}><Icon name="check" />{t('Approvals')}</Link>
        {meta.user.employeeId && <Link href="/me" className={item(path === '/me')}><Icon name="users" />{t('My HR')}</Link>}
        <div className="px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-[var(--sidebar-muted)]">{t('Modules')}</div>
        {groups.map((g) => {
          const active = g.items.some((i) => path.startsWith(i.href));
          const open = openGroup === g.key || (openGroup === null && active);
          return (
            <div key={g.key}>
              <button aria-expanded={open} onClick={() => setOpenGroup(open ? '' : g.key)} className={cx(item(false), 'w-full', active && 'text-white')}>
                <Icon name={g.icon} />
                <span className="flex-1 text-start">{t(g.label)}</span>
                <span className={cx('transition-transform rtl:rotate-180', open && 'rotate-90 rtl:rotate-90')}><Icon name="chevron" className="h-3.5 w-3.5" /></span>
              </button>
              {open && (() => {
                const link = (i: { href: string; label: string }) => <Link key={i.href} href={i.href} className={cx('block rounded-md px-2.5 py-1.5 transition-colors', path === i.href ? 'bg-[var(--sidebar-active)] font-medium text-white' : 'hover:bg-[var(--sidebar-hover)] hover:text-white')}>{t(i.label)}</Link>;
                const mine = g.items.filter((i) => EMPLOYEE_SCREENS.has(i.href));
                const manage = g.items.filter((i) => !EMPLOYEE_SCREENS.has(i.href));
                const head = (label: string) => <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--sidebar-muted)]">{t(label)}</div>;
                return (
                  <div className="my-1 ms-[1.1rem] space-y-0.5 border-s border-white/10 ps-2.5">
                    {mine.length > 0 && manage.length > 0 ? <>{head('Employee')}{mine.map(link)}{head('Management & admin')}{manage.map(link)}</> : g.items.map(link)}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </nav>
      <div className="shrink-0 border-t border-white/5 p-3">
        <Link href="/account" className="flex items-center gap-2.5 rounded-lg p-2 hover:bg-[var(--sidebar-hover)]">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--sidebar-active)] text-xs font-semibold text-white">{initials}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm text-white">{meta.user.name}</span><span className="block text-xs text-[var(--sidebar-muted)]">{t('My account')}</span></span>
        </Link>
        <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
          <button onClick={() => setLocale(meta.user.locale === 'ur' ? 'en' : 'ur')} aria-label={t('Language')} className="flex items-center justify-center gap-1.5 rounded-md py-1.5 hover:bg-[var(--sidebar-hover)] hover:text-white"><Icon name="globe" className="h-3.5 w-3.5" />{meta.user.locale === 'ur' ? 'English' : 'اردو'}</button>
          <button onClick={logout} className="flex items-center justify-center gap-1.5 rounded-md py-1.5 hover:bg-[var(--sidebar-hover)] hover:text-white"><Icon name="logout" className="h-3.5 w-3.5" />{t('Sign out')}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="no-print sticky top-0 hidden h-screen w-60 shrink-0 lg:block">{sidebar}</aside>
      {nav && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setNav(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 start-0 w-72" onClick={(e) => e.stopPropagation()}>{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:px-4">
          <Button variant="ghost" size="sm" className="lg:hidden" aria-label="Menu" onClick={() => setNav(true)}><Icon name="menu" className="h-5 w-5" /></Button>
          <button onClick={() => setSearch(true)} className="flex h-10 max-w-md flex-1 items-center gap-2 rounded-lg border border-border bg-field px-3 text-sm text-muted-foreground transition hover:border-muted-foreground/40">
            <Icon name="search" /><span className="flex-1 truncate text-start">{t('Search or scan…')}</span><kbd className="hidden rounded border border-border px-1.5 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <div className="ms-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" aria-label="Toggle dark mode" onClick={toggle}><Icon name={mode === 'dark' ? 'sun' : 'moon'} /></Button>
            <div className="relative">
              <Button variant="ghost" size="sm" aria-label={`Notifications, ${notes.unread} unread`} onClick={() => setShowNotes((s) => !s)}>
                <span className="relative"><Icon name="bell" />{notes.unread > 0 && <span className="absolute -end-2 -top-2 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 text-white">{notes.unread > 99 ? '99+' : notes.unread}</span>}</span>
              </Button>
              {showNotes && (
                <div className="absolute end-0 mt-1 w-80 rounded-[var(--radius)] border border-border bg-card shadow-lg">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm font-medium">
                    {t('Notifications')}
                    <button className="text-xs text-primary" onClick={() => api('notifications/read', 'POST', {}).then(() => setNotes((n) => ({ ...n, unread: 0 })))}>{t('Mark all read')}</button>
                  </div>
                  <ul className="max-h-96 overflow-auto">
                    {notes.items.map((n) => (
                      <li key={n.id}>
                        <button className={cx('block w-full px-3 py-2 text-start text-sm hover:bg-muted', !n.readAt && 'font-medium')}
                          onClick={() => { setShowNotes(false); api('notifications/read', 'POST', { ids: [n.id] }); if (n.link) router.push(n.link); }}>
                          {n.title}<div className="text-xs font-normal text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</div>
                        </button>
                      </li>
                    ))}
                    {!notes.items.length && <li className="px-3 py-4 text-center text-sm text-muted-foreground">You&apos;re all caught up</li>}
                  </ul>
                </div>
              )}
            </div>
            <Link href="/account" aria-label={t('My account')} className="ms-1 grid h-8 w-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{initials}</Link>
          </div>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-[1600px] flex-1 p-4 pb-24 lg:p-8 lg:pb-8">{children}</main>
        <nav aria-label="Quick" className="no-print fixed inset-x-0 bottom-0 z-30 grid h-14 grid-cols-4 border-t border-border bg-card/95 text-center text-[11px] backdrop-blur lg:hidden">
          <Link href="/" className={cx("flex flex-col items-center justify-center gap-0.5", path === "/" && "text-primary")}><Icon name="home" />{t('Home')}</Link>
          <Link href="/approvals" className={cx("flex flex-col items-center justify-center gap-0.5", path === "/approvals" && "text-primary")}><Icon name="check" />{t('Approvals')}</Link>
          <button onClick={() => setSearch(true)} className="flex flex-col items-center justify-center gap-0.5"><Icon name="scan" />{t('Scan')}</button>
          <button onClick={() => setNav(true)} className="flex flex-col items-center justify-center gap-0.5"><Icon name="menu" />{t('Menu')}</button>
        </nav>
      </div>
      <SearchDialog open={search} onClose={() => setSearch(false)} />
    </div>
  );
}

/** Ctrl+K global search. USB scanners type + Enter: exact code resolves straight to the record. Phones scan with the live camera (HTTPS) or a photo (works on plain HTTP too). */
function SearchDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const meta = useMeta();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [camera, setCamera] = useState(false);
  const [note, setNote] = useState('');
  const [unknown, setUnknown] = useState(''); // last scanned code that matched nothing
  const video = useRef<HTMLVideoElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  // Browsers only open the live camera on HTTPS (or localhost); a photo works everywhere.
  const liveOk = typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const label = (t: string) => meta.resources.find((r) => r.key === t)?.label ?? t;
  const go = (h: Hit) => { onClose(); setQ(''); router.push(`/r/${h.entityType}/${h.entityId}`); };

  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api<Hit[]>(`search?${qs({ q })}`).then(setHits).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q]);

  const scan = async (code: string) => {
    // A kiosk's rotating QR: check in at that kiosk instead of searching.
    if (code.startsWith('ERPKIOSK:')) {
      setHits([]); setUnknown('');
      try {
        const r = await api<{ station: string; at: string }>('hrm/attendance/scan', 'POST', { payload: code, idempotencyKey: crypto.randomUUID() });
        setNote(`✓ Checked in at ${r.station} — ${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      } catch (e) { setNote(`✕ ${e instanceof Error ? e.message : 'Check-in failed'}`); }
      return;
    }
    const found = await api<Hit[]>(`search/scan?${qs({ code })}`);
    if (found.length === 1) go(found[0]);
    else { setHits(found); setUnknown(found.length ? '' : code); if (!found.length) setNote(`Nothing found for “${code}”.`); }
  };

  useEffect(() => {
    if (!camera || !open) return;
    let stream: MediaStream | null = null;
    let live = true;
    setNote('');
    (async () => {
      const det = await barcodeDetector();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (!video.current || !live) return;
      video.current.srcObject = stream;
      await video.current.play();
      while (live) {
        const codes = await det.detect(video.current).catch(() => []);
        if (codes[0]) { live = false; setCamera(false); await scan(codes[0].rawValue); break; }
        await new Promise((r) => setTimeout(r, 250));
      }
    })().catch(() => { setCamera(false); setNote('Camera not available — use “Photo” instead.'); });
    return () => { live = false; stream?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, open]);

  return (
    <Dialog open={open} onClose={onClose} title="Search">
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) scan(q.trim()); }} className="flex gap-2">
        <Input autoFocus placeholder="Name, number, serial, IMEI, SKU, plate… or scan" value={q} onChange={(e) => setQ(e.target.value)} />
        {liveOk && <Button type="button" variant="outline" onClick={() => setCamera((c) => !c)} aria-label="Scan with camera" title="Live camera">📷</Button>}
        <Button type="button" variant="outline" onClick={() => photo.current?.click()} aria-label="Scan from a photo" title="Take a photo of the code">Photo</Button>
      </form>
      {/* Photo scan: the phone opens its camera app; the picture is decoded here, nothing is uploaded. */}
      <input ref={photo} type="file" accept="image/*" capture="environment" className="sr-only" aria-hidden="true" tabIndex={-1} onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setNote('Reading code…');
        try {
          const codes = await (await barcodeDetector()).detect(await createImageBitmap(f));
          if (codes[0]) { setNote(''); setQ(codes[0].rawValue); await scan(codes[0].rawValue); } else setNote('No barcode or QR code found — get closer and keep it sharp.');
        } catch { setNote('Could not read that picture.'); }
      }} />
      {!liveOk && <p className="mt-2 text-xs text-muted-foreground">Live camera scanning needs HTTPS; use “Photo” to scan with the phone camera.</p>}
      {note && <p className="mt-2 text-sm text-muted-foreground" role="status">{note}</p>}
      {/* A new item's barcode: start its product record with the code already filled in. */}
      {unknown && can(meta, 'inventory.product.create') && (
        <Button size="sm" variant="outline" className="mt-2" onClick={() => { onClose(); router.push(`/r/inventory.product/new?${qs({ barcode: unknown })}`); setUnknown(''); }}>Create product with barcode {unknown}</Button>
      )}
      {camera && <video ref={video} className="mt-3 w-full rounded" muted playsInline />}
      <ul className="mt-3 divide-y divide-border">
        {hits.map((h) => (
          <li key={`${h.entityType}:${h.entityId}`}>
            <button className="flex w-full items-center justify-between gap-2 px-1 py-2 text-start text-sm hover:bg-muted" onClick={() => go(h)}>
              <span>{h.title}{h.subtitle && <span className="ms-2 text-xs text-muted-foreground">{h.subtitle}</span>}</span>
              <span className="text-xs text-muted-foreground">{label(h.entityType)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
