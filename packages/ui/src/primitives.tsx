'use client';
import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useEffect, useRef } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type Variant = 'primary' | 'outline' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:brightness-110 active:brightness-95',
  outline: 'border border-border bg-card hover:bg-muted',
  ghost: 'hover:bg-muted',
  danger: 'bg-danger text-white hover:opacity-90',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }>(
  ({ variant = 'primary', size = 'md', className, ...p }, ref) => (
    <button
      ref={ref}
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-medium transition disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-10 px-4 text-sm',
        variants[variant],
        className,
      )}
    />
  ),
);
Button.displayName = 'Button';

const base = 'rounded-[var(--radius)] border border-border bg-field px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/70 hover:border-muted-foreground/40 focus:border-primary focus:bg-card focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';
/** Full width unless the caller sets a width (avoids w-full vs w-56 class fights). */
const field = (className?: string) => cx(base, !/(^|\s)w-/.test(className ?? '') && 'w-full');

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} {...p} className={cx(p.type === 'checkbox' ? 'h-4 w-4 accent-[var(--primary)]' : field(className), p.type === 'checkbox' ? '' : 'h-10', className)} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} rows={3} {...p} className={cx(field(className), 'py-2', className)} />
));
Textarea.displayName = 'Textarea';

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(field(className), 'h-10 pe-8', className)}>{children}</select>;
}

export function Label({ children, required, htmlFor }: { children: ReactNode; required?: boolean; htmlFor?: string }) {
  return <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-foreground/80">{children}{required && <span className="ms-0.5 text-danger" aria-hidden="true">*</span>}</label>;
}

export function Card({ className, children, title, actions }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-border bg-card shadow-[var(--shadow)]', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-[calc(1.25rem*var(--density))]">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

export function KpiCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow)]">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={tone ? { color: `var(--tone-${tone})` } : undefined}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="max-w-sm text-xs text-muted-foreground">{hint}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-muted', className)} />;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="alert" className="rounded-[var(--radius)] border px-3 py-2 text-sm" style={{ color: 'var(--tone-red)', background: 'var(--tone-red-bg)', borderColor: 'var(--tone-red)' }}>{error instanceof Error ? error.message : String(error)}</div>;
}

/** Native <dialog>: focus trap, Esc and backdrop for free. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose(): void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm', wide ? 'max-w-4xl' : 'max-w-md overflow-visible')}>
      {open && (
        <div className={cx('flex flex-col', wide && 'max-h-[85vh]')}>
          <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="font-semibold">{title}</h2>
            <button aria-label="Close" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted">✕</button>
          </header>
          {/* Small dialogs don't scroll, so dropdowns inside them are never clipped. */}
          <div className={cx('p-5', wide && 'overflow-auto')}>{children}</div>
          {footer && <footer className="flex justify-end gap-2 rounded-b-xl border-t border-border bg-muted/40 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange(k: string): void }) {
  return (
    <div role="tablist" className="mb-3 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm', value === t.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Timeline({ items }: { items: { at: string | Date; title: ReactNode; body?: ReactNode }[] }) {
  if (!items.length) return <EmptyState title="No activity yet" />;
  return (
    <ol className="relative ms-2 border-s border-border">
      {items.map((it, i) => (
        <li key={i} className="mb-4 ms-4">
          <span className="absolute -start-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-card bg-primary" />
          <div className="text-xs text-muted-foreground">{new Date(it.at).toLocaleString()}</div>
          <div className="text-sm">{it.title}</div>
          {it.body && <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}

export function Menu({ label, items }: { label: ReactNode; items: { label: string; onClick(): void; disabled?: boolean }[] }) {
  return (
    <details className="relative">
      <summary className="list-none">
        <span className="inline-flex h-10 cursor-pointer items-center gap-1 rounded-[var(--radius)] border border-border bg-card px-3 text-sm hover:bg-muted">{label} <span className="text-muted-foreground">▾</span></span>
      </summary>
      <div className="absolute end-0 z-30 mt-1 min-w-40 rounded-[var(--radius)] border border-border bg-card py-1 shadow-lg">
        {items.map((it) => (
          <button key={it.label} disabled={it.disabled}
            onClick={(e) => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; it.onClick(); }}
            className="block w-full px-3 py-1.5 text-start text-sm hover:bg-muted disabled:opacity-40">{it.label}</button>
        ))}
      </div>
    </details>
  );
}

/** Accessible on/off switch (a styled checkbox). */
export function Switch({ id, checked, onChange, disabled, label }: { id?: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean; label?: ReactNode }) {
  return (
    <label className={cx('inline-flex select-none items-center gap-2.5 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input id={id} type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative h-5 w-9 rounded-full bg-muted-foreground/30 transition peer-checked:bg-primary peer-focus-visible:ring-4 peer-focus-visible:ring-primary/20 after:absolute after:start-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-4 rtl:peer-checked:after:-translate-x-4" />
      {label}
    </label>
  );
}

/** Numbered pagination with range summary and page-size picker; collapses to prev/next on small screens. */
export function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [10, 25, 50, 100], labels = {} }: {
  page: number; pageSize: number; total: number; onPage(p: number): void; onPageSize(n: number): void; sizes?: number[];
  labels?: { rows?: string; of?: string; prev?: string; next?: string };
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  const nums: (number | '…')[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  const btn = 'inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2 text-sm tabular-nums transition disabled:pointer-events-none disabled:opacity-40';
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="tabular-nums"><b className="font-medium text-foreground">{from.toLocaleString()}–{to.toLocaleString()}</b> {labels.of ?? 'of'} {total.toLocaleString()}</span>
        <label className="hidden items-center gap-2 sm:flex">
          {labels.rows ?? 'Rows'}
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="h-9 rounded-lg border border-border bg-field px-2 text-foreground">
            {sizes.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-1">
        <button className={cx(btn, 'border border-border bg-card hover:bg-muted')} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={labels.prev ?? 'Previous page'}>
          <span aria-hidden="true" className="rtl:rotate-180">‹</span>
        </button>
        {nums.map((n, i) => n === '…'
          ? <span key={`e${i}`} className="hidden px-1 text-muted-foreground sm:inline">…</span>
          : <button key={n} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}
              className={cx(btn, 'hidden sm:inline-flex', n === page ? 'bg-primary font-medium text-primary-foreground' : 'hover:bg-muted')}>{n}</button>)}
        <span className="px-2 tabular-nums text-muted-foreground sm:hidden">{page} / {pages}</span>
        <button className={cx(btn, 'border border-border bg-card hover:bg-muted')} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={labels.next ?? 'Next page'}>
          <span aria-hidden="true" className="rtl:rotate-180">›</span>
        </button>
      </div>
    </nav>
  );
}
