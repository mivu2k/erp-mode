'use client';
import { Button, cx, Dialog, ErrorBox } from '@erp/ui';
import { useState } from 'react';
import { raw } from './api';

interface Result { committed: boolean; created: number; updated: number; errors: number; rows: { row: number; action: 'create' | 'update' | 'error'; sku?: string; name?: string; brand?: string | null; kind?: string; error?: string }[] }

const TEMPLATE = 'Name,SKU,Type,Brand,Model,Barcode,Other barcodes,Price,Reorder level,Category,Unit,Track serial,Warranty months,Compatible with\n'
  + 'Motorola APX 6000 battery,,Part,,NNTN8128,,,4500,5,,,No,6,APX 6000; APX 8000\n'
  + 'Hytera PD785 handheld radio,,Product,Hytera,PD785,6971234567890,,85000,2,,,Yes,12,\n';

/** Import products / spare parts from Excel or CSV: preview first (what each row will do), then import. */
export function ProductImport({ open, onClose, kind }: { open: boolean; onClose(): void; kind: 'product' | 'part' }) {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async (commit: boolean) => {
    if (!file) return;
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await raw(`inventory/products/import?kind=${kind}${commit ? '&commit=1' : ''}`, { method: 'POST', body: fd });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.message ?? `Error ${r.status}`);
      setRes(body);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const template = () => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' })), download: 'products-import-template.csv' });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const close = () => { const done = res?.committed; setFile(null); setRes(null); setError(null); onClose(); if (done) location.reload(); };
  const good = res ? res.created + res.updated : 0;

  return (
    <Dialog open={open} onClose={close} title={`Import ${kind === 'part' ? 'spare parts' : 'products'}`} wide
      footer={res?.committed ? <Button onClick={close}>Done</Button> : <>
        <Button variant="ghost" onClick={close}>Cancel</Button>
        {!res ? <Button disabled={!file || busy} onClick={() => send(false)}>{busy ? 'Checking…' : 'Check file'}</Button>
          : <Button disabled={!good || busy} onClick={() => send(true)}>{busy ? 'Importing…' : `Import ${good} row${good === 1 ? '' : 's'}`}</Button>}
      </>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Excel (.xlsx) or CSV with a <b>Name</b> column; everything else is optional. A blank <b>SKU</b> is generated, a blank <b>Brand</b> is picked up from the name,
          and a row whose SKU already exists <b>updates</b> that item. Rows without a Type become {kind === 'part' ? 'spare parts' : 'products'}.
          <button type="button" className="ms-1 text-primary hover:underline" onClick={template}>Download a template</button>
        </p>
        <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Import file"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); }} />
        <ErrorBox error={error} />
        {res && (
          <>
            <p role="status">
              {res.committed ? 'Imported: ' : 'Ready: '}<b>{res.created}</b> new · <b>{res.updated}</b> updated
              {res.errors > 0 && <span style={{ color: 'var(--tone-red)' }}> · {res.errors} row{res.errors === 1 ? '' : 's'} with problems{res.committed ? ' (skipped)' : ' — fix them in the file, or import the rest'}</span>}
            </p>
            <div className="max-h-80 overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground"><tr>{['Row', '', 'SKU', 'Name', 'Brand', 'Type'].map((h) => <th key={h} className="px-2 py-1.5 text-start font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {res.rows.map((r) => (
                    <tr key={r.row} className="border-t border-border/60">
                      <td className="px-2 py-1 tabular-nums">{r.row}</td>
                      <td className="px-2 py-1"><span className={cx('rounded px-1.5 py-0.5', r.action === 'error' ? 'text-red-600' : 'text-muted-foreground')}>{r.action === 'create' ? 'new' : r.action === 'update' ? 'update' : 'problem'}</span></td>
                      <td className="px-2 py-1 font-mono">{r.sku ?? ''}</td>
                      <td className="px-2 py-1">{r.name ?? ''}{r.error && <div className="text-red-600">{r.error}</div>}</td>
                      <td className="px-2 py-1">{r.brand ?? ''}</td>
                      <td className="px-2 py-1">{r.kind === 'part' ? 'Part' : r.kind ? 'Product' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
