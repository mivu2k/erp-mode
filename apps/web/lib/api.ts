'use client';

let access: string | null = null;
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

/** Flattens Nest/Zod error bodies into one readable line. */
function messageOf(body: unknown, status: number): string {
  if (status === 429) return 'Too many attempts from this network — wait a minute and try again.';
  // Validation errors arrive either wrapped ({ message: {fieldErrors} }) or bare ({ fieldErrors }).
  const b = body as { message?: unknown; fieldErrors?: unknown } | null;
  const m = b?.message ?? (b?.fieldErrors ? b : undefined);
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.join(', ');
  if (m && typeof m === 'object') {
    const { formErrors = [], fieldErrors = {} } = m as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    return [...formErrors, ...Object.entries(fieldErrors).map(([k, v]) => `${fieldName(k)}: ${v.map(plain).join(', ')}`)].join(' · ') || `Error ${status}`;
  }
  return `Error ${status}`;
}
/** employeeId → "Employee", inAt → "In at". */
const fieldName = (k: string) => { const s = k.replace(/Id$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
/** Zod's wording for a blank field reads as "required". */
const plain = (msg: string) => (/received (null|undefined)|^Required$/i.test(msg) ? 'required' : msg);

/**
 * New access token from the refresh cookie. Only a 401 means the session is over; "too many requests" (429),
 * server errors and dropped connections are retried, so a busy moment never signs the user out.
 */
export async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 2s, 4s, 8s
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
      if (r?.ok) { access = (await r.json()).accessToken; return true; }
      if (r && r.status !== 429 && r.status < 500) { access = null; return false; }
    }
    return false;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export const hasToken = () => !!access;
export const getToken = () => access;
export const setToken = (t: string | null) => { access = t; };

export async function raw(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const res = await fetch(`/api/${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}), ...init.headers },
  });
  if (res.status === 401 && retry && !path.startsWith('auth/')) {
    if (await refresh()) return raw(path, init, false);
    if (typeof window !== 'undefined' && !location.pathname.startsWith('/login')) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, messageOf(body, res.status), body);
  }
  return res;
}

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await raw(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Opens printable HTML in a new tab, or downloads files (csv/xlsx), with auth. */
export async function openDoc(path: string) {
  const win = window.open('', '_blank');
  try {
    const res = await raw(path);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disp = res.headers.get('content-disposition');
    if (disp?.includes('attachment')) {
      win?.close();
      const a = Object.assign(document.createElement('a'), { href: url, download: disp.match(/filename="(.+)"/)?.[1] ?? 'export' });
      a.click();
    } else if (res.headers.get('content-type')?.includes('json')) {
      const data = JSON.parse(await blob.text());
      if (win) win.document.body.innerHTML = `<pre style="font:12px monospace;white-space:pre-wrap">${JSON.stringify(data, null, 2).replace(/</g, '&lt;')}</pre>`;
    } else if (win) win.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

export const qs = (o: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString();
