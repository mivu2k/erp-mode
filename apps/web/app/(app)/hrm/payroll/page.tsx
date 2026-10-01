'use client';
import { Button, Card, ErrorBox, FormGrid, PageHeader } from '@erp/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { renderRef } from '@/lib/RefPicker';

export default function PayrollRun() {
  const router = useRouter();
  const [v, setV] = useState<Record<string, unknown>>({ period: new Date().toISOString().slice(0, 7) });
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <PageHeader title="Run payroll" />
      <Card>
        <p className="mb-3 text-sm text-muted-foreground">Pulls processed attendance, unpaid leave, overtime and salary-advance installments for every employee with a salary structure. The run starts as a draft; submit it for approval, then post it to the ledger.</p>
        <FormGrid fields={[{ name: 'period', type: 'string', required: true, label: 'Period (YYYY-MM)' }, { name: 'branchId', type: 'string', ref: 'core.branch', label: 'Branch (optional)' }]} values={v} renderRef={renderRef} onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))} />
        <div className="mt-3"><ErrorBox error={error} /></div>
        <Button className="mt-3" onClick={() => api<{ id: string }>('hrm/payroll/generate', 'POST', v).then((r) => router.push(`/r/hrm.payroll/${r.id}`)).catch(setError)}>Generate payslips</Button>
      </Card>
    </>
  );
}
