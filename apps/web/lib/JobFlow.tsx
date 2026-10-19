'use client';
import { Button, Card, cx, StatusBadge } from '@erp/ui';
import type { ActionDef } from '@erp/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, qs } from './api';

type Rec = Record<string, unknown> & { _refs?: Record<string, string | null> };
interface Doc { id: string; number: string; status: string; total?: string | number; paid?: string | number }

/** The repair path, in order; statuses in between map onto the step they belong to. */
const STEPS: [string, string][] = [['received', 'Received'], ['diagnosed', 'Diagnosed'], ['quoted', 'Quoted'], ['approved', 'Approved'], ['in_repair', 'In repair'], ['qc', 'QC'], ['ready', 'Ready'], ['delivered', 'Delivered'], ['closed', 'Closed']];
const STEP_OF: Record<string, string> = {
  received: 'received', assigned: 'received', diagnosing: 'received', diagnosed: 'diagnosed', quotation_sent: 'quoted', approved: 'approved',
  parts_pending: 'approved', in_repair: 'in_repair', qc: 'qc', ready: 'ready', delivered: 'delivered', closed: 'closed', rma: 'in_repair',
  declined: 'quoted', not_repairable: 'diagnosed', returned_unrepaired: 'ready',
};
const OFF_PATH: Record<string, string> = { declined: 'Customer declined the quotation', not_repairable: 'Not repairable', returned_unrepaired: 'Returned unrepaired', rma: 'Out to the vendor (RMA)' };

/**
 * A repair job as a workflow: where it is on the repair path, and the one next step with its button
 * (job actions open their usual dialogs; quotation / invoice steps link to that document).
 */
export function JobFlow({ rec, jobId, actions, onAction }: { rec: Rec; jobId: string; actions: ActionDef[]; onAction(a: ActionDef): void }) {
  const status = String(rec.status ?? 'received');
  const [quote, setQuote] = useState<Doc | null>(null);
  const [invoice, setInvoice] = useState<Doc | null>(null);
  useEffect(() => {
    const f = encodeURIComponent(JSON.stringify({ jobId }));
    api<{ rows: Doc[] }>(`r/repair.quotation?${qs({ pageSize: 1, sort: 'createdAt:desc' })}&filters=${f}`).then((d) => setQuote(d.rows[0] ?? null)).catch(() => {});
    api<{ rows: Doc[] }>(`r/repair.invoice?${qs({ pageSize: 1, sort: 'createdAt:desc' })}&filters=${f}`).then((d) => setInvoice(d.rows[0] ?? null)).catch(() => {});
  }, [jobId, status]);

  const act = (name: string) => actions.find((a) => a.name === name);
  const current = STEPS.findIndex(([k]) => k === (STEP_OF[status] ?? 'received'));
  const unpaid = invoice && Number(invoice.paid ?? 0) < Number(invoice.total ?? 0);

  // The next step in words, with its button(s): job actions run here, document steps open the document.
  const next: { title: string; text: string; buttons: (ActionDef | { label: string; href: string })[] } = (() => {
    const job = (...names: string[]) => names.map(act).filter((a): a is ActionDef => !!a);
    const q = quote ? [{ label: `Open quotation ${quote.number}`, href: `/r/repair.quotation/${quote.id}` }] : [];
    const inv = invoice ? [{ label: `Open invoice ${invoice.number}`, href: `/r/repair.invoice/${invoice.id}` }] : [];
    switch (status) {
      case 'received': return { title: 'Assign a technician', text: 'Who will look at this unit? You can also go straight to the diagnosis.', buttons: job('assign', 'diagnose') };
      case 'assigned': case 'diagnosing': return { title: 'Diagnose and quote', text: 'Record the findings and the parts and labour needed — a quotation is prepared from them.', buttons: job('diagnose', 'status') };
      case 'diagnosed': return { title: 'Send the quotation to the customer', text: 'Review the quotation, then mark it sent (or record the customer’s answer if you already have it).', buttons: [...q, ...job('diagnose', 'status')] };
      case 'quotation_sent': return { title: 'Waiting for the customer’s decision', text: 'Record whether the customer accepted or declined the quotation.', buttons: q };
      case 'approved': case 'parts_pending': return { title: 'Issue the parts and start the repair', text: 'Issue the reserved parts from the store in the Parts card below. Labour-only jobs can go straight to the QC test. The invoice comes once the unit is ready.', buttons: job('test') };
      case 'in_repair': return { title: 'Repair, then test', text: 'When the work is done, record the bench / QC test. A pass makes the unit ready for pickup.', buttons: job('test', 'status') };
      case 'qc': return { title: 'Record the QC test', text: 'A pass makes the unit ready; a fail sends it back to repair.', buttons: job('test') };
      case 'ready': return invoice
        ? { title: unpaid ? 'Take payment and hand over' : 'Hand the unit over', text: unpaid ? 'Receive payment on the invoice, then deliver.' : 'Paid — deliver the unit to the customer.', buttons: [...inv, ...job('deliver')] }
        : { title: 'Invoice and hand over', text: 'Create the invoice from the accepted quotation, take payment, then deliver.', buttons: job('invoice', 'deliver') };
      case 'delivered': return unpaid
        ? { title: 'Collect the payment', text: 'The unit is with the customer but the invoice is not fully paid. The job closes itself once it is.', buttons: inv }
        : { title: 'Delivered', text: 'The job closes itself once every invoice for it is paid.', buttons: [...inv, ...job('comeback')] };
      case 'closed': return { title: 'Job closed', text: 'Delivered and paid. If the fault comes back, open a comeback job.', buttons: [...inv, ...job('comeback')] };
      default: return { title: OFF_PATH[status] ?? 'Next step', text: 'Charge an inspection fee if needed, then return the unit to the customer.', buttons: job('invoice', 'deliver') };
    }
  })();

  return (
    <Card className="mb-4">
      {/* Progress along the repair path */}
      <ol className="flex flex-wrap items-center gap-y-2" aria-label="Repair progress">
        {STEPS.map(([k, label], i) => (
          <li key={k} className="flex items-center" aria-current={i === current ? 'step' : undefined}>
            <span className={cx('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              i < current ? 'text-foreground' : i === current ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              <span className={cx('grid h-5 w-5 place-items-center rounded-full text-[10px]', i < current ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : i === current ? 'bg-white/25' : 'border border-border')}>{i < current ? '✓' : i + 1}</span>
              {label}
            </span>
            {i < STEPS.length - 1 && <span className={cx('mx-1 h-px w-4 sm:w-6', i < current ? 'bg-emerald-500/50' : 'bg-border')} aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {OFF_PATH[status] && <p className="mt-3 rounded-md px-3 py-1.5 text-sm" style={{ color: 'var(--tone-amber)', background: 'var(--tone-amber-bg)' }}>{OFF_PATH[status]}</p>}

      {/* The one next step */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Next step</div>
          <div className="text-lg font-semibold">{next.title}</div>
          <p className="max-w-2xl text-sm text-muted-foreground">{next.text}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {next.buttons.map((b, i) => 'href' in b
            ? <Link key={b.href} href={b.href}><Button variant={i === 0 ? undefined : 'outline'}>{b.label}</Button></Link>
            : <Button key={b.name} variant={i === 0 ? undefined : b.name === 'status' ? 'ghost' : 'outline'} onClick={() => onAction(b)}>{b.label}</Button>)}
        </div>
      </div>

      {/* Documents of this job */}
      {(quote || invoice) && (
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
          {quote && <span>Quotation <Link className="text-primary hover:underline" href={`/r/repair.quotation/${quote.id}`}>{quote.number}</Link> <StatusBadge status={quote.status} /></span>}
          {invoice && <span>Invoice <Link className="text-primary hover:underline" href={`/r/repair.invoice/${invoice.id}`}>{invoice.number}</Link> <StatusBadge status={invoice.status} /></span>}
        </div>
      )}
    </Card>
  );
}
