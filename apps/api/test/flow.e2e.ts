import { execSync } from 'node:child_process';
/**
 * End-to-end business flow against a running API + seeded DB.
 *   API_URL=http://localhost:4000/api node --import tsx --test apps/api/test/flow.e2e.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const API = process.env.API_URL ?? 'http://localhost:4000/api';
const run = Date.now().toString(36);
let token = '';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test boundary
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<J> {
  const res = await fetch(`${API}/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : { text };
}
const list = async (key: string, filters: object = {}) => (await call('GET', `r/${key}?filters=${encodeURIComponent(JSON.stringify(filters))}&pageSize=100`)).rows as J[];
const approveAll = async (key: string, id: string) => {
  const sub = await call('POST', `r/${key}/${id}/submit`);
  if (sub.autoApproved) return;
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', `approvals/${sub.requestId}/approve`, {});
    if (r.status === 'approved') return;
  }
};

/** Approves every step of a submitted request (admin override) — used for payment vouchers. */
const release = async (res: J) => {
  for (let i = 0; res.requestId && i < 5; i++) if ((await call('POST', `approvals/${res.requestId}/approve`, {})).status === 'approved') break;
};

let ctx: J = {};

test('auth + meta', async () => {
  assert.equal((await call('GET', 'health')).status, 'ok');
  await assert.rejects(call('POST', 'auth/login', { login: 'admin@erp.local', password: 'wrong' }), /401/);
  const r = await call('POST', 'auth/login', { login: 'admin@erp.local', password: 'Admin@12345' });
  token = r.accessToken;
  assert.ok(r.refreshToken);
  const rotated = await call('POST', 'auth/refresh', { refreshToken: r.refreshToken });
  await assert.rejects(call('POST', 'auth/refresh', { refreshToken: r.refreshToken }), /401/); // reuse detected
  await assert.rejects(call('POST', 'auth/refresh', { refreshToken: rotated.refreshToken }), /401/); // whole family revoked
  const meta = await call('GET', 'meta');
  assert.ok(meta.resources.length > 50);
  const accounts = await list('finance.account', { code: { in: ['1110', '1120', '3100'] } });
  const md = await list('core.masterdata', { code: { in: ['FUEL', 'LABOR-STD', 'BENCH'] } });
  ctx = {
    cash: accounts.find((a) => a.code === '1110').id,
    bank: accounts.find((a) => a.code === '1120').id,
    director: accounts.find((a) => a.code === '3100').id,
    fuelHead: md.find((m) => m.code === 'FUEL').id,
    labor: md.find((m) => m.code === 'LABOR-STD').id,
    wh: (await list('inventory.warehouse')).find((w) => w.code === 'MAIN').id,
  };
});

test('HRM: employee gets ledger account; user link; own-scope login', async () => {
  const dept = (await list('core.department'))[0];
  const emp = await call('POST', 'r/hrm.employee', { name: `Ali ${run}`, departmentId: dept.id, nfcUid: `NFC-${run}`, joinDate: '2026-01-01' });
  assert.match(emp.code, /^EMP-\d{4}$/);
  assert.ok(emp.accountId, 'finance sub-account auto-created');
  await call('POST', `hrm/employees/${emp.id}/create-user`, { email: `ali.${run}@erp.local`, password: 'Secret123' });
  ctx.emp = emp;
  await assert.rejects(call('POST', 'r/hrm.employee', { name: 'x', departmentId: 'not-a-real-id' }), /400/); // cross-ref check
});

test('Finance: cash in, advance → disburse, claim against advance settles difference', async () => {
  const cashIn = await call('POST', 'r/finance.cash', { date: '2026-09-01', fromAccountId: ctx.director, toAccountId: ctx.cash, amount: '100000', memo: 'Director cash in' });
  // Regression: hooks must run once (module classes are instantiated twice by Nest).
  assert.equal((await list('finance.journal', { sourceType: 'finance.cash', sourceId: cashIn.id })).length, 1);
  const adv = await call('POST', 'r/finance.advance', { employeeId: ctx.emp.id, kind: 'expense', amount: '10000', purpose: 'Site visit' });
  await approveAll('finance.advance', adv.id);
  const dv = await call('POST', `finance/advances/${adv.id}/disburse`, { accountId: ctx.cash });
  assert.equal((await call('GET', `r/finance.advance/${adv.id}`)).status, 'disbursement_pending', 'no cash moves before the voucher is approved');
  await release(dv);
  assert.equal((await call('GET', `r/finance.advance/${adv.id}`)).status, 'disbursed');
  const claim = await call('POST', 'r/finance.claim', {
    employeeId: ctx.emp.id, mode: 'against_advance', advanceId: adv.id, date: '2026-09-03',
    lines: [{ date: '2026-09-02', headId: ctx.fuelHead, description: 'Fuel', amount: '4000' }, { date: '2026-09-02', headId: ctx.fuelHead, description: 'Fuel 2', amount: '3500.50' }],
  });
  assert.equal(Number(claim.total), 7500.5);
  // Fully covered by the advance: approval itself settles it (no zero-amount voucher) and the advance goes down.
  await approveAll('finance.claim', claim.id);
  const settled = await call('GET', `r/finance.claim/${claim.id}`);
  assert.equal(settled.status, 'settled');
  assert.deepEqual([Number(settled.fromAdvance), Number(settled.reimbursed), Number(settled.refundDue)], [7500.5, 0, 2499.5]);
  assert.equal(Number((await call('GET', `r/finance.advance/${adv.id}`)).recovered), 7500.5);
  assert.equal((await list('finance.voucher', { sourceId: claim.id })).length, 0);
  await call('POST', `finance/claims/${claim.id}/return-advance`, { accountId: ctx.cash }); // returns exactly the unspent 2,499.50
  assert.equal((await call('GET', `r/finance.advance/${adv.id}`)).status, 'settled');
  const st = await call('GET', `finance/statement/employee/${ctx.emp.id}`);
  assert.equal(st.totals[0][1], 0, 'employee account back to zero');
});

test('Inventory + Purchase: PO → GRN with serials → weighted average', async () => {
  const vendor = await call('POST', 'r/purchase.vendor', { name: `Parts Co ${run}` });
  const screen = await call('POST', 'r/inventory.product', { sku: `SCR-${run}`, name: 'iPhone 13 Screen', price: '9000', reorderLevel: '2' });
  const phone = await call('POST', 'r/inventory.product', { sku: `PH-${run}`, name: 'Demo Phone', price: '150000', serialized: true });
  const po = await call('POST', 'r/purchase.order', { vendorId: vendor.id, date: '2026-09-04', lines: [{ productId: screen.id, qty: '10', price: '5000' }, { productId: phone.id, qty: '2', price: '100000' }] });
  assert.equal(Number(po.total), 250000);
  await approveAll('purchase.order', po.id);
  const [l1, l2] = po.lines;
  await call('POST', `purchase/orders/${po.id}/receive`, { warehouseId: ctx.wh, lines: [{ lineId: l1.id, qty: 4 }] });
  const po2 = await call('POST', 'r/purchase.order', { vendorId: vendor.id, date: '2026-09-04', lines: [{ productId: screen.id, qty: '4', price: '6500' }] });
  await approveAll('purchase.order', po2.id);
  await call('POST', `purchase/orders/${po2.id}/receive`, { warehouseId: ctx.wh, lines: [{ lineId: po2.lines[0].id, qty: 4 }] });
  await call('POST', `purchase/orders/${po.id}/receive`, { warehouseId: ctx.wh, lines: [{ lineId: l2.id, qty: 2, serials: [`SN1-${run}`, `SN2-${run}`] }] });
  const lvl = (await list('inventory.stock', { productId: screen.id }))[0];
  assert.equal(Number(lvl.qty), 8);
  assert.equal(Number(lvl.avgCost), 5750);
  assert.equal((await call('GET', `r/purchase.order/${po.id}`)).status, 'partially_received');
  ctx = { ...ctx, screen, phone };
});

test('Repair: intake → diagnose/quote → accept → issue → invoice → pay → deliver', async () => {
  const cust = await call('POST', 'r/sales.customer', { name: `Customer ${run}`, phone: '0300' });
  const intake = await call('POST', 'repair/intakes', { customerId: cust.id, items: [
    { productType: 'Handheld radio', brand: 'Motorola', model: 'APX 6000', serial: `IMEI-${run}`, assetTag: `UNIT-${run}`, frequencyBand: 'VHF 136-174 MHz', firmwareVersion: 'R01.00', zeroized: true, accessories: ['Battery', 'Antenna'], fault: 'No transmit', password: '1234' },
    { productType: 'Gateway / router', brand: 'Cisco', model: 'IR1101', fault: 'Network link down' },
  ] });
  assert.equal(intake.jobs.length, 2);
  const jobId = intake.jobs[0].id;
  await call('POST', `repair/jobs/${jobId}/assign`, { technicianId: ctx.emp.id });
  const d = await call('POST', `repair/jobs/${jobId}/diagnose`, { findings: 'LCD cracked', parts: [{ productId: ctx.screen.id, qty: 1 }], labor: [{ serviceId: ctx.labor, qty: 1 }] });
  assert.equal(Number(d.quotation.total), 10500);
  await call('POST', `repair/quotations/${d.quotation.id}/decision`, { accepted: true, via: 'phone' });
  await call('POST', `repair/jobs/${jobId}/issue-parts`, { warehouseId: ctx.wh });
  // Statuses follow the work: no manual moves. Ready still needs a passing test.
  await assert.rejects(call('POST', `repair/jobs/${jobId}/status`, { status: 'ready' }), /Cannot move|passing QC test/);
  await call('POST', `repair/jobs/${jobId}/test`, { rfPowerW: 1.2, freqErrorHz: 900, vswr: 3.1, pass: false, notes: 'High VSWR' });
  assert.equal((await call('GET', `r/repair.job/${jobId}`)).status, 'in_repair', 'failed QC goes back to repair');
  await call('POST', `repair/jobs/${jobId}/test`, { rfPowerW: 5, rxSensitivity: '0.25 µV', freqErrorHz: 120, vswr: 1.3, audioOk: true, firmwareAfter: 'R02.10', pass: true });
  const passed = await call('GET', `r/repair.job/${jobId}`);
  assert.equal(passed.status, 'ready', 'a passing QC test makes the unit ready for pickup');
  assert.equal(passed.firmwareVersion, 'R02.10');
  await assert.rejects(call('POST', `repair/jobs/${jobId}/status`, { status: 'received' }), /Cannot move/);
  const inv = await call('POST', `repair/jobs/${jobId}/invoice`, {});
  await call('POST', `repair/invoices/${inv.id}/pay`, { amount: 5000, accountId: ctx.cash });
  const p2 = await call('POST', `repair/invoices/${inv.id}/pay`, { amount: 5500, accountId: ctx.cash, idempotencyKey: `pay-${run}` });
  assert.equal(p2.status, 'paid');
  await call('POST', `repair/jobs/${jobId}/deliver`, { receivedBy: 'Customer' });
  assert.equal((await call('GET', `r/repair.job/${jobId}`)).status, 'closed', 'delivered and fully paid closes the job');
  assert.equal((await call('POST', `repair/jobs/${jobId}/password`)).password, '1234');
  const track = await fetch(`${API}/public/track/${intake.jobs[0].trackToken}`).then((r) => r.json());
  assert.equal(track.status, 'closed');
  const found = await call('GET', `search?q=${encodeURIComponent(`IMEI-${run}`)}`);
  assert.ok(found.length >= 1);
  const scan = await call('GET', `search/scan?code=${encodeURIComponent(intake.jobs[0].number)}`);
  assert.equal(scan[0].entityId, jobId);
  const byTag = await call('GET', `search/scan?code=${encodeURIComponent(`UNIT-${run}`)}`);
  assert.ok(byTag.some((h: J) => h.entityId === jobId), 'asset tag resolves to the job');
  ctx.customer = cust;
});

test('Gatepass: demo out → partial return → convert rest to sale', async () => {
  const gp = await call('POST', 'r/gatepass.pass', {
    type: 'demo_out', partyName: 'Client Org', customerId: ctx.customer.id, fromWarehouseId: ctx.wh, expectedReturn: '2026-10-01',
    lines: [{ productId: ctx.phone.id, serial: `SN1-${run}`, qty: '1' }, { productId: ctx.phone.id, serial: `SN2-${run}`, qty: '1' }],
  });
  await approveAll('gatepass.pass', gp.id);
  await call('POST', `gatepass/${gp.id}/check`, { direction: 'out' });
  const g = await call('GET', `r/gatepass.pass/${gp.id}`);
  await call('POST', `gatepass/${gp.id}/check`, { direction: 'in', lines: [{ lineId: g.lines[0].id, qty: 1, condition: 'ok' }] });
  const inv = await call('POST', `gatepass/${gp.id}/convert`, { customerId: ctx.customer.id, lines: [{ lineId: g.lines[1].id, qty: 1 }] });
  assert.equal(Number(inv.total), 150000);
  assert.equal((await call('GET', `r/gatepass.pass/${gp.id}`)).status, 'closed'); // one returned, one sold
  const serials = await list('serials.item', { serial: `SN2-${run}` });
  assert.equal(serials[0].status, 'sold');
});

test('Attendance: pair kiosk → NFC punch (idempotent) → process day', async () => {
  const st = await call('POST', 'r/hrm.station', { name: `Gate ${run}`, lat: 33.7, lng: 73.0 });
  const { code } = await call('POST', `hrm/kiosk/stations/${st.id}/pairing-code`);
  const saved = token;
  token = '';
  const { deviceToken } = await call('POST', 'hrm/kiosk/pair', { code });
  const h = { 'x-device-token': deviceToken };
  await call('POST', 'hrm/kiosk/punch', { nfcUid: `NFC-${run}`, at: '2026-09-22T04:25:00Z', idempotencyKey: `k1-${run}` }, h); // 09:25 PKT
  await call('POST', 'hrm/kiosk/punch', { nfcUid: `NFC-${run}`, at: '2026-09-22T04:25:00Z', idempotencyKey: `k1-${run}` }, h); // offline replay
  await call('POST', 'hrm/kiosk/punch', { nfcUid: `NFC-${run}`, at: '2026-09-22T12:10:00Z', idempotencyKey: `k2-${run}` }, h); // 17:10 PKT
  token = saved;
  await call('POST', 'hrm/attendance/process', { date: '2026-09-22' });
  const day = (await list('hrm.attendance', { employeeId: ctx.emp.id }))[0];
  assert.equal(day.status, 'late');
  assert.equal(day.lateMin, 25);
  assert.equal((await list('hrm.punch', { employeeId: ctx.emp.id })).length, 2);
});

test('Payroll: generate → approve → post → pay; salary advance recovered', async () => {
  await call('POST', 'r/hrm.salary', { employeeId: ctx.emp.id, basic: '60000', components: [{ name: 'House rent', kind: 'allowance', mode: 'percent', value: 10 }] });
  const loan = await call('POST', 'r/finance.loan', { employeeId: ctx.emp.id, amount: '12000', installments: 3, purpose: 'Family emergency' });
  assert.match(loan.number, /^LOAN-/);
  ctx.loanId = loan.id;
  await approveAll('finance.loan', loan.id);
  await release(await call('POST', `finance/advances/${loan.id}/disburse`, { accountId: ctx.cash }));
  // Unique per run: 96,000 year-month slots (years 2000–9999 × 12), one per second, so past runs don't collide.
  const slot = Math.floor(Date.now() / 1000) % 96_000;
  const run1 = await call('POST', 'hrm/payroll/generate', { period: `${2000 + (slot % 8000)}-${String(1 + Math.floor(slot / 8000)).padStart(2, '0')}` });
  await approveAll('hrm.payroll', run1.id);
  await call('POST', `hrm/payroll/${run1.id}/post`);
  const slip = (await list('hrm.payslip', { runId: run1.id })).find((s) => s.employeeId === ctx.emp.id)!;
  assert.equal(Number(slip.advanceDeduction), 4000);
  await call('POST', `hrm/payslips/${slip.id}/pay`, { amount: Number(slip.net), accountId: ctx.bank });
  assert.equal(Number((await call('GET', `r/finance.loan/${loan.id}`)).recovered), 4000);
});

test('Ledger balances; reports; exports; audit', async () => {
  const tb = await call('GET', 'finance/trial-balance');
  assert.equal(tb.totals[0][1], tb.totals[1][1], 'trial balance debits = credits');
  const rep = await call('POST', 'reports/run', { definition: { resource: 'repair.job', groupBy: ['status'] } });
  assert.ok(rep.rows.length >= 1);
  const saved = await call('GET', 'reports/available');
  const r2 = await call('GET', `reports/${saved.find((r: J) => r.name === 'Advances outstanding').id}/run`);
  assert.ok(r2.columns.includes('outstanding'));
  const csv = await call('GET', 'r/hrm.employee/export?format=csv');
  assert.match(csv.text, /Ali/);
  const html = await call('GET', `print/repair.invoice/${(await list('repair.invoice'))[0].id}?size=80`);
  assert.match(html.text, /<svg/);
  assert.ok((await list('core.audit')).length > 10);
  const dash = await call('GET', 'repair/dashboard');
  assert.ok(dash.byStatus.length);
});

// ─── Round 2: PDF, live notifications, jobs, workflow extras, email outbox ───

import { createServer } from 'node:net';

/** Minimal SMTP sink so the real mail path (nodemailer → SMTP) is exercised. */
function smtpSink() {
  const mails: string[] = [];
  const server = createServer((sock) => {
    let data = false;
    let buf = '';
    sock.write('220 sink\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; sock.write('250 ok\r\n'); } else mails[mails.length - 1] += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 sink\r\n');
        else if (cmd === 'DATA') { data = true; mails.push(''); sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  server.unref(); // never keep the test process alive
  return new Promise<{ port: number; mails: string[]; close(): void }>((res) => server.listen(0, '127.0.0.1', () => res({ port: (server.address() as { port: number }).port, mails, close: () => server.close() })));
}

test('PDF rendering (record + report)', async () => {
  const inv = (await list('repair.invoice'))[0];
  const res = await fetch(`${API}/print/repair.invoice/${inv.id}?format=pdf`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  // A5: a real A5 page (148×210mm ≈ 420×595pt), not A4 scaled.
  const a5 = Buffer.from(await (await fetch(`${API}/print/repair.invoice/${inv.id}?size=a5&format=pdf`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer()).toString('latin1');
  assert.match(a5, /MediaBox \[0 0 4(19|20)[\d.]* 59[45][\d.]*\]/);
  const tb = await fetch(`${API}/finance/trial-balance?format=pdf`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(Buffer.from(await tb.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});

test('parallel approval + delegation + escalation config', async () => {
  const roles = (await call('GET', 'r/core.role?pageSize=100')).rows as J[];
  const acct = roles.find((r) => r.name === 'Accountant')!;
  const u1 = await call('POST', 'r/core.user', { name: `Acc1 ${run}`, email: `acc1.${run}@erp.local`, password: 'Secret123' });
  const u2 = await call('POST', 'r/core.user', { name: `Acc2 ${run}`, email: `acc2.${run}@erp.local`, password: 'Secret123' });
  const cover = await call('POST', 'r/core.user', { name: `Cover ${run}`, email: `cover.${run}@erp.local`, password: 'Secret123' });
  for (const u of [u1, u2]) await call('POST', `users/${u.id}/roles`, { roleIds: [acct.id] });
  await call('POST', 'r/core.workflow', { name: `Dual sign ${run}`, resource: 'finance.cash', priority: 99, steps: [{ name: 'Both accountants', approverType: 'role', approverId: acct.id, mode: 'all', escalateAfterHours: 24, escalateToRoleId: acct.id }] }).catch(() => null);
  // workflow on a non-workflow resource is ignored; use a claim instead
  const wf = await call('POST', 'r/core.workflow', { name: `Dual sign claim ${run}`, resource: 'finance.claim', priority: 99, conditions: { equals: { notes: `dual ${run}` } }, steps: [{ name: 'Both accountants', approverType: 'role', approverId: acct.id, mode: 'all' }] });

  const loginAs = async (email: string) => (await call('POST', 'auth/login', { login: email, password: 'Secret123' })).accessToken as string;
  const admin = token;
  // Only accountants in this company would block; restrict role to our two users by removing others.
  const holders = (await call('GET', `r/core.user?pageSize=100`)).rows as J[];
  for (const h of holders) {
    if (h.id === u1.id || h.id === u2.id) continue;
    const r = await call('GET', `users/${h.id}/roles`) as unknown as string[];
    if (r.includes(acct.id)) await call('POST', `users/${h.id}/roles`, { roleIds: r.filter((x) => x !== acct.id) });
  }

  token = await loginAs(`acc2.${run}@erp.local`);
  await call('POST', 'auth/preferences', { delegateToId: cover.id, delegateUntil: new Date(Date.now() + 86_400_000).toISOString() });
  token = admin;

  const claim = await call('POST', 'r/finance.claim', { employeeId: ctx.emp.id, mode: 'direct', date: '2026-09-10', notes: `dual ${run}`, lines: [{ date: '2026-09-10', headId: ctx.fuelHead, amount: '500' }] });
  const sub = await call('POST', `r/finance.claim/${claim.id}/submit`);
  assert.equal(sub.status, 'pending');

  token = await loginAs(`acc1.${run}@erp.local`);
  const first = await call('POST', `approvals/${sub.requestId}/approve`, {});
  assert.equal(first.status, 'pending', 'still waiting for the second accountant');
  assert.equal((await call('GET', 'approvals/inbox')).filter((r: J) => r.id === sub.requestId).length, 0, 'acc1 already signed');

  token = await loginAs(`cover.${run}@erp.local`); // delegate of acc2
  assert.equal((await call('GET', 'approvals/inbox')).filter((r: J) => r.id === sub.requestId).length, 1);
  // A request created before approvers were recorded is routed on the next inbox read.
  execSync(`mysql -h127.0.0.1 -P3307 -uerp -perp erp -e "DELETE FROM ApprovalAssignee WHERE requestId='${sub.requestId}'" 2>/dev/null`);
  assert.equal((await call('GET', 'approvals/inbox')).filter((r: J) => r.id === sub.requestId).length, 1, 'legacy request re-routed');
  const second = await call('POST', `approvals/${sub.requestId}/approve`, {});
  assert.equal(second.status, 'approved');
  token = admin;
  await call('DELETE', `r/core.workflow/${wf.id}`);
});

test('live notifications over SSE', async () => {
  const me = await call('GET', 'auth/me');
  const mine = (await list('hrm.employee', { userId: me.id }))[0] ?? (await call('POST', 'r/hrm.employee', { name: `Admin Emp ${run}`, userId: me.id }));
  const ac = new AbortController();
  let text = '';
  try {
    const res = await fetch(`${API}/notifications/stream?token=${token}`, { signal: ac.signal });
    assert.equal(res.headers.get('content-type')?.split(';')[0], 'text/event-stream');
    const reader = res.body!.getReader();
    await call('POST', 'r/hrm.task', { title: `For admin ${run}`, assigneeId: mine.id });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !text.includes(`For admin ${run}`)) {
      const { value } = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array }>((r) => setTimeout(() => r({}), 6_000))]);
      if (value) text += new TextDecoder().decode(value);
    }
  } finally {
    ac.abort();
  }
  assert.match(text, new RegExp(`For admin ${run}`));
});

test('jobs: nightly (recurring task) + email outbox via SMTP', async () => {
  const tpl = await call('POST', 'r/hrm.task', { title: `Daily check ${run}`, assigneeId: ctx.emp.id, recurrence: 'daily' });
  const nightly = await call('POST', 'admin/jobs/nightly/run');
  // Created today = today's occurrence; the next copy is generated tomorrow (timing covered by recurrenceDue unit test).
  assert.equal(Object.values(nightly as Record<string, J>)[0].recurringTasks.created, 0);
  assert.ok(tpl.id);

  const me = await call('GET', 'auth/me');
  const mine = (await list('hrm.employee', { userId: me.id }))[0] ?? (await call('POST', 'r/hrm.employee', { name: `Admin Emp ${run}`, userId: me.id }));
  const sink = await smtpSink();
  const prev = await call('GET', 'admin/settings');
  let r: J;
  try {
    await call('PUT', 'admin/settings/smtp', { value: { host: '127.0.0.1', port: sink.port, secure: false, user: '', pass: '', from: 'ERP <erp@test.local>' } });
    await call('POST', 'r/hrm.task', { title: `Mail me ${run}`, assigneeId: mine.id });
    // The outbox sends in batches, oldest first: drain any backlog (e.g. overdue notices from earlier runs) until ours goes.
    let sent = 0;
    for (let i = 0; i < 30 && !sink.mails.some((m) => m.includes(`Mail me ${run}`)); i++) {
      r = await call('POST', 'admin/jobs/outbox/run');
      sent += r.sent;
      if (!r.sent) break;
    }
    r = { ...r!, sent };
  } finally {
    sink.close();
    await call('PUT', 'admin/settings/smtp', { value: prev.smtp });
  }
  assert.ok(r.sent >= 1, JSON.stringify(r));
  assert.ok(sink.mails.some((m) => m.includes(`Mail me ${run}`)), sink.mails.join('\n---\n').slice(0, 500));
});

// ─── Round 3: custom fields in lists/exports, time tracking, stock count, SMS webhook ───

import { createServer as httpServer } from 'node:http';

test('custom fields: validated on write, filterable, exportable', async () => {
  const name = `blood${run}`;
  const cf = await call('POST', 'r/core.customfield', { resource: 'hrm.employee', name, label: `Blood group ${run}`, type: 'enum', options: ['A+', 'B+', 'O+'] });
  await assert.rejects(call('POST', 'r/core.customfield', { resource: 'hrm.employee', name: `${name}x`, label: `Blood group ${run}`, type: 'string' }), /already exists on this form/);
  try {
  await assert.rejects(call('POST', 'r/hrm.employee', { name: `Bad ${run}`, custom: { [name]: 'Z' } }), /400/);
  const e = await call('POST', 'r/hrm.employee', { name: `Custom ${run}`, custom: { [name]: 'O+' } });
  assert.equal(e.custom[name], 'O+');
  const hits = await list('hrm.employee', { [`custom.${name}`]: 'O+' });
  assert.deepEqual(hits.map((h) => h.id), [e.id]);
  const csv = await call('GET', `r/hrm.employee/export?format=csv&columns=name,custom.${name}&filters=${encodeURIComponent(JSON.stringify({ [`custom.${name}`]: 'O+' }))}`);
  assert.match(csv.text, new RegExp(`Custom ${run},O\\+`));
  } finally {
    await call('DELETE', `r/core.customfield/${cf.id}`); // don't leave test fields on the real HR form
  }
});

test('time tracking: start → stop logs minutes', async () => {
  const t = await call('POST', 'r/hrm.task', { title: `Timed ${run}` });
  await call('POST', `time/hrm.task/${t.id}/start`);
  let s = await call('GET', `time/hrm.task/${t.id}`);
  assert.ok(s.running);
  await call('POST', 'time/stop', {});
  s = await call('GET', `time/hrm.task/${t.id}`);
  assert.equal(s.running, null);
  assert.equal(s.total, 1);
});

test('stock count posts only the difference', async () => {
  const before = Number((await list('inventory.stock', { productId: ctx.screen.id, warehouseId: ctx.wh }))[0].qty);
  const adj = await call('POST', 'r/inventory.adjustment', { kind: 'count', warehouseId: ctx.wh, lines: [{ productId: ctx.screen.id, qty: before + 3 }] });
  await approveAll('inventory.adjustment', adj.id);
  await call('POST', `inventory/adjustments/${adj.id}/post`);
  assert.equal(Number((await list('inventory.stock', { productId: ctx.screen.id, warehouseId: ctx.wh }))[0].qty), before + 3);
});

test('SMS/WhatsApp webhook channel', async () => {
  const got: J[] = [];
  const srv = httpServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { got.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.end('ok'); });
  });
  srv.unref();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const me = await call('GET', 'auth/me');
  const mine = (await list('hrm.employee', { userId: me.id }))[0] ?? (await call('POST', 'r/hrm.employee', { name: `Admin Emp ${run}`, userId: me.id }));
  await call('PATCH', `r/hrm.employee/${mine.id}`, { phone: '+923001112233' });
  await call('POST', 'auth/preferences', { notifySms: true });
  try {
    await call('PUT', 'admin/settings/sms', { value: { webhookUrl: `http://127.0.0.1:${port}/send`, token: 'secret-t' } });
    await call('POST', 'r/hrm.task', { title: `SMS me ${run}`, assigneeId: mine.id });
    await call('POST', 'admin/jobs/outbox/run');
  } finally {
    await call('PUT', 'admin/settings/sms', { value: { webhookUrl: '', token: '' } });
    await call('POST', 'auth/preferences', { notifySms: false });
    srv.close();
  }
  const m = got.find((g) => String(g.text).includes(`SMS me ${run}`));
  assert.ok(m, JSON.stringify(got));
  assert.equal(m.to, '+923001112233');
  assert.equal(m.auth, 'Bearer secret-t');
});

test('payables & receivables: create (with monthly repeat), timeline, pay, ledger', async () => {
  const accounts = await list('finance.account', { code: { in: ['4100', '5330'] } });
  const income = accounts.find((a) => a.code === '4100')!.id;
  const expense = accounts.find((a) => a.code === '5330')!.id;
  const vendor = (await list('purchase.vendor'))[0];
  const rent = await call('POST', 'r/payables.due', { direction: 'payable', vendorId: vendor.id, description: `Rent ${run}`, amount: '30000', dueDate: '2026-10-01', accountId: expense, repeatMonths: 3 });
  assert.equal(rent.partyName, vendor.name);
  const rents = await list('payables.due', { description: `Rent ${run}` });
  assert.equal(rents.length, 3);
  const loan = await call('POST', 'r/payables.due', { direction: 'receivable', partyName: `Friend ${run}`, description: `Loan ${run}`, amount: '5000', dueDate: '2026-01-15', accountId: income });
  await assert.rejects(call('POST', 'r/payables.due', { direction: 'receivable', description: 'no party', amount: '1', dueDate: '2026-01-01', accountId: income }), /party/);

  const tl = await call('GET', 'finance/dues/timeline');
  const mine = tl.rows.filter((r: J) => String(r.description).includes(run));
  assert.equal(mine.length, 4);
  assert.equal(mine[0].number, loan.number, 'sorted by due date');
  assert.equal(mine[0].bucket, 'overdue');
  assert.ok(mine[0].daysOverdue > 200 && mine[0].aging === '90+', 'days overdue + aging bucket');
  assert.equal(tl.forecast.length, 8);
  assert.equal(typeof tl.totals.cash, 'number');
  assert.ok(tl.aging.receivable['90+'] >= 5000);
  assert.ok(tl.parties.some((p: J) => p.party === `Friend ${run}` && p.direction === 'receivable'));

  await call('POST', `finance/dues/${loan.id}/pay`, { amount: 2000, accountId: ctx.cash });
  await assert.rejects(call('POST', `finance/dues/${loan.id}/pay`, { amount: 3000.01, accountId: ctx.cash }), /outstanding/);
  await call('POST', `finance/dues/${loan.id}/pay`, { amount: 3000, accountId: ctx.cash });
  assert.equal((await call('GET', `r/payables.due/${loan.id}`)).status, 'settled');
  const tb = await call('GET', 'finance/trial-balance');
  assert.equal(tb.totals[0][1], tb.totals[1][1]);
});

test('fleet maintenance jobs live under Fleet, not in the Repair job list', async () => {
  const v = await call('POST', 'r/fleet.vehicle', { plate: `LEA-${run}`, make: 'Toyota', model: 'Hilux', odometer: 12000 });
  const m = await call('POST', `fleet/vehicles/${v.id}/maintenance`, { fault: 'Brake noise' });
  assert.equal((await list('fleet.maintenance', { vehicleId: v.id }))[0].id, m.id);
  assert.equal((await list('repair.job', { number: m.number })).length, 0);
  await assert.rejects(call('GET', `r/repair.job/${m.id}`), /404/);
  assert.equal((await call('GET', `r/fleet.maintenance/${m.id}`)).number, m.number);
});

test('uploads: real type check, stream back, photo field, ID card embeds photo', async () => {
  // 1×1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const emp = await call('POST', 'r/hrm.employee', { name: `Photo ${run}` });
  const up = async (buf: Buffer, name: string, type: string) => {
    const fd = new FormData();
    fd.append('entityType', 'hrm.employee');
    fd.append('entityId', emp.id);
    fd.append('file', new Blob([buf], { type }), name);
    const res = await fetch(`${API}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    return { status: res.status, body: await res.json() };
  };
  const ok = await up(png, 'face.png', 'image/png');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.mimeType, 'image/png');
  const bad = await up(Buffer.from('MZ\x90\x00this is not an image'), 'evil.png', 'image/png');
  assert.equal(bad.status, 400, 'executable disguised as PNG is rejected');

  const dl = await fetch(`${API}/attachments/${ok.body.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), png);

  await call('PATCH', `r/hrm.employee/${emp.id}`, { photo: ok.body.id });
  await assert.rejects(call('PATCH', `r/hrm.employee/${emp.id}`, { photo: 'not-an-attachment' }), /file not found/);
  const card = await call('GET', `print/hrm.employee/${emp.id}?template=idcard`);
  assert.match(card.text, /data:image\/png;base64,/);
});

test('product image gallery + company logo (data URL) on prints', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const p = await call('POST', 'r/inventory.product', { sku: `IMG-${run}`, name: `Antenna ${run}`, price: '1200' });
  const ids: string[] = [];
  for (const n of ['a.png', 'b.png']) {
    const fd = new FormData();
    fd.append('entityType', 'inventory.product');
    fd.append('entityId', p.id);
    fd.append('file', new Blob([png], { type: 'image/png' }), n);
    ids.push((await (await fetch(`${API}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json()).id);
  }
  assert.deepEqual((await call('PATCH', `r/inventory.product/${p.id}`, { images: ids.reverse() })).images, ids);
  await assert.rejects(call('PATCH', `r/inventory.product/${p.id}`, { images: [ids[0], 'bogus'] }), /file not found/);

  const company = (await list('core.company'))[0];
  const logo = `data:image/png;base64,${png.toString('base64')}`;
  await assert.rejects(call('PATCH', `r/core.company/${company.id}`, { branding: { ...company.branding, logo: 'data:image/svg+xml;base64,PHN2Zz4=' } }), /PNG, JPEG or WebP/);
  await assert.rejects(call('PATCH', `r/core.company/${company.id}`, { branding: { ...company.branding, logo: 'javascript:alert(1)' } }), /PNG, JPEG or WebP/);
  await call('PATCH', `r/core.company/${company.id}`, { branding: { ...company.branding, logo } });
  const inv = (await list('repair.invoice'))[0];
  assert.ok((await call('GET', `print/repair.invoice/${inv.id}?size=80`)).text.includes(logo.slice(0, 60)));
  await call('PATCH', `r/core.company/${company.id}`, { branding: company.branding });
});

test('loans vs expense advances are separate; maker-checker on payment vouchers; rejected voucher hands back', async () => {
  // The loan from the payroll test lives only on the loans screen.
  assert.ok((await list('finance.loan', { number: { contains: 'LOAN-' } })).some((x) => x.id === ctx.loanId));
  assert.ok(!(await list('finance.advance')).some((x) => x.id === ctx.loanId));
  await assert.rejects(call('GET', `r/finance.advance/${ctx.loanId}`), /404/);

  // An accountant prepares a reimbursement voucher and may not approve it themselves.
  const roles = (await call('GET', 'r/core.role?pageSize=100')).rows as J[];
  const acct = roles.find((r) => r.name === 'Accountant')!;
  const maker = await call('POST', 'r/core.user', { name: `Maker ${run}`, email: `maker.${run}@erp.local`, password: 'Secret123' });
  await call('POST', `users/${maker.id}/roles`, { roleIds: [acct.id] });
  const claim = await call('POST', 'r/finance.claim', { employeeId: ctx.emp.id, mode: 'direct', date: '2026-09-20', notes: `mc ${run}`, lines: [{ date: '2026-09-20', headId: ctx.fuelHead, amount: '800' }] });
  await approveAll('finance.claim', claim.id);
  const admin = token;
  token = (await call('POST', 'auth/login', { login: `maker.${run}@erp.local`, password: 'Secret123' })).accessToken;
  const pv = await call('POST', `finance/claims/${claim.id}/pay`, { accountId: ctx.cash, notes: 'Fuel reimbursement' });
  assert.equal(pv.status, 'pending');
  await assert.rejects(call('POST', `approvals/${pv.requestId}/approve`, {}), /own request/);
  assert.equal((await call('GET', 'approvals/inbox')).filter((r: J) => r.id === pv.requestId).length, 0, 'not in the maker inbox');
  await assert.rejects(call('POST', `finance/claims/${claim.id}/pay`, { accountId: ctx.cash }), /already waiting|approved first/);
  token = admin;
  await call('POST', `approvals/${pv.requestId}/reject`, { comment: 'Wrong account' });
  assert.equal((await call('GET', `r/finance.claim/${claim.id}`)).status, 'approved', 'rejected voucher hands the claim back');
  await release(await call('POST', `finance/claims/${claim.id}/pay`, { accountId: ctx.cash }));
  assert.equal((await call('GET', `r/finance.claim/${claim.id}`)).status, 'paid');
});

test('advance repayment: installment detected, custom part payment, full settlement', async () => {
  const adv = await call('POST', 'r/finance.advance', { employeeId: ctx.emp.id, kind: 'expense', amount: '10000', installments: 4, purpose: `inst ${run}` });
  assert.equal(Number(adv.installmentAmount), 2500, 'amount divided by installments');
  await approveAll('finance.advance', adv.id);
  await release(await call('POST', `finance/advances/${adv.id}/disburse`, { accountId: ctx.cash }));
  const pay = (body: J) => call('POST', `finance/advances/${adv.id}/return`, { accountId: ctx.cash, ...body });
  assert.deepEqual(await pay({ mode: 'next_installment' }), { reference: 'Installment 1/4', paid: 2500, outstanding: 7500, next: { installment: '2/4', due: 2500 } });
  assert.deepEqual(await pay({ mode: 'custom_amount', amount: 1000 }), { reference: 'Part payment — installment 2/4', paid: 1000, outstanding: 6500, next: { installment: '2/4', due: 1500 } });
  assert.equal((await pay({ mode: 'next_installment' })).paid, 1500, 'completes the part-paid installment');
  await assert.rejects(pay({ mode: 'custom_amount' }), /Enter the amount/);
  await assert.rejects(pay({ mode: 'custom_amount', amount: 99999 }), /Outstanding is 5000/);
  const last = await pay({ mode: 'full_settlement' });
  assert.deepEqual([last.paid, last.outstanding, last.next], [5000, 0, null]);
  assert.match(last.reference, /^Full settlement/);
  assert.equal((await call('GET', `r/finance.advance/${adv.id}`)).status, 'settled');
  const refs = (await list('finance.payment', { refId: adv.id, direction: 'in' })).map((p) => p.reference).sort();
  assert.deepEqual(refs, ['Full settlement (after installment 2/4)', 'Installment 1/4', 'Installment 2/4', 'Part payment — installment 2/4']);
});

test('expense claim: partial approval with reason, then reimbursed in two parts', async () => {
  const claim = await call('POST', 'r/finance.claim', { employeeId: ctx.emp.id, mode: 'direct', date: '2026-09-21', notes: `part ${run}`, lines: [
    { date: '2026-09-21', headId: ctx.fuelHead, description: 'Fuel', amount: '1000' }, { date: '2026-09-21', headId: ctx.fuelHead, description: 'Dinner', amount: '600' },
  ] });
  const sub = await call('POST', `r/finance.claim/${claim.id}/submit`);
  const full = await call('GET', `r/finance.claim/${claim.id}`);
  const [fuel, dinner] = ['Fuel', 'Dinner'].map((d) => full.lines.find((l: J) => l.description === d).id);
  await assert.rejects(call('POST', `finance/claims/${claim.id}/adjust`, { lines: [{ lineId: dinner, approved: 0 }] }), /reason/);
  await assert.rejects(call('POST', `finance/claims/${claim.id}/adjust`, { lines: [{ lineId: fuel, approved: 1200 }], note: 'x' }), /more than claimed/);
  assert.deepEqual(await call('POST', `finance/claims/${claim.id}/adjust`, { lines: [{ lineId: fuel, approved: 900 }, { lineId: dinner, approved: 0 }], note: 'Dinner not covered by policy' }), { approvedTotal: 900, claimed: 1600 });
  for (let i = 0; i < 5; i++) if ((await call('POST', `approvals/${sub.requestId}/approve`, {})).status === 'approved') break;
  await assert.rejects(call('POST', `finance/claims/${claim.id}/pay`, { accountId: ctx.cash, amount: 1000 }), /Only 900 is left/);
  await release(await call('POST', `finance/claims/${claim.id}/pay`, { accountId: ctx.cash, amount: 400 }));
  let c = await call('GET', `r/finance.claim/${claim.id}`);
  assert.deepEqual([c.status, Number(c.reimbursed), Number(c.approvedTotal)], ['partially_paid', 400, 900]);
  const pv = await call('POST', `finance/claims/${claim.id}/pay`, { accountId: ctx.cash });
  assert.equal((await call('GET', `r/finance.voucher/${pv.voucherId}`)).breakdown.thisPayment, 500, 'blank amount = remaining balance');
  await release(pv);
  c = await call('GET', `r/finance.claim/${claim.id}`);
  assert.deepEqual([c.status, Number(c.reimbursed)], ['paid', 900]);
  const je = await list('finance.journal', { sourceType: 'finance.claim', sourceId: claim.id });
  assert.equal(je.length, 3, 'expense booked once + two payments');
});

test('super admin override: edit/delete locked and read-only records, never ledgers or own account', async () => {
  const claim = await call('POST', 'r/finance.claim', { employeeId: ctx.emp.id, mode: 'direct', date: '2026-09-22', notes: `ovr ${run}`, lines: [{ date: '2026-09-22', headId: ctx.fuelHead, amount: '300' }] });
  await approveAll('finance.claim', claim.id);
  const edited = await call('PATCH', `r/finance.claim/${claim.id}`, { notes: `ovr edited ${run}`, status: 'rejected' });
  assert.deepEqual([edited.notes, edited.status], [`ovr edited ${run}`, 'approved'], 'locked record editable, but status stays system-driven');
  const audit = await list('core.audit', { entityId: claim.id, action: 'override_update' });
  assert.equal(audit.length, 1, 'override is audited');
  await call('DELETE', `r/finance.claim/${claim.id}`);
  assert.equal((await list('core.audit', { entityId: claim.id, action: 'override_delete' })).length, 1);
  const je = (await list('finance.journal'))[0];
  await assert.rejects(call('PATCH', `r/finance.journal/${je.id}`, { memo: 'x' }), /403|workflow actions/);
  const me = await call('GET', 'auth/me');
  await assert.rejects(call('DELETE', `r/core.user/${me.id}`), /signed in with/);
  // Without the override permission the lock still holds.
  const admin = token;
  token = (await call('POST', 'auth/login', { login: `maker.${run}@erp.local`, password: 'Secret123' })).accessToken;
  const c2 = (await list('finance.claim', { status: 'paid' }))[0];
  await assert.rejects(call('PATCH', `r/finance.claim/${c2.id}`, { notes: 'x' }), /Locked while paid|403/);
  token = admin;
});

test('utilities: site → connection → readings → bill (auto units & charges) → payable on P&R → pay → tracker', async () => {
  const expense = (await list('finance.account', { code: '5330' }))[0].id;
  const site = await call('POST', 'r/utilities.site', { name: `Tower ${run}`, address: 'Sector F-8' });
  const vendor = (await list('purchase.vendor'))[0];
  await assert.rejects(call('POST', 'r/utilities.connection', { siteId: site.id, name: 'x', accountId: (await list('finance.account', { isGroup: true }))[0].id }), /expense account/);
  const conn = await call('POST', 'r/utilities.connection', { siteId: site.id, name: `Tower ${run} – Electricity`, type: 'electricity', vendorId: vendor.id, accountNo: `AC-${run}`, meterNo: 'M-1', unit: 'kWh', tariff: '40', fixedCharge: '500', billingDay: 5, dueDays: 14, accountId: expense });
  assert.equal(conn.provider, vendor.name, 'provider autofilled from vendor');
  await call('POST', `utilities/connections/${conn.id}/reading`, { date: '2026-07-31', reading: 10000 });
  const r2 = await call('POST', `utilities/connections/${conn.id}/reading`, { date: '2026-08-31', reading: 10350 });
  assert.deepEqual([Number(r2.previous), Number(r2.consumption)], [10000, 350]);
  await assert.rejects(call('POST', `utilities/connections/${conn.id}/reading`, { date: '2026-09-01', reading: 10300 }), /lower than the previous/);
  await assert.rejects(call('POST', `utilities/connections/${conn.id}/reading`, { date: '2026-08-01', reading: 10400 }), /later reading/);

  const bill = await call('POST', `utilities/connections/${conn.id}/bill`, { billDate: '2026-09-05', periodFrom: '2026-07-31', periodTo: '2026-08-31', tax: '1500', billRef: 'LESCO-99' });
  assert.deepEqual([Number(bill.units), Number(bill.energyCharge), Number(bill.fixedCharge), Number(bill.total), bill.dueDate.slice(0, 10), bill.status], [350, 14000, 500, 16000, '2026-09-19', 'unpaid']);
  assert.equal(bill.siteId, site.id);
  await assert.rejects(call('POST', `utilities/connections/${conn.id}/bill`, { billDate: '2026-09-20', energyCharge: '100' }), /already has a bill for 2026-09/);
  const due = await call('GET', `r/payables.due/${bill.dueId}`);
  assert.deepEqual([due.direction, Number(due.amount), due.vendorId], ['payable', 16000, vendor.id], 'booked as a payable on P&R');

  await call('POST', `utilities/bills/${bill.id}/dispute`, { reason: 'Wrong tariff' });
  await assert.rejects(call('POST', `utilities/bills/${bill.id}/pay`, { amount: 100, accountId: ctx.cash }), /Resolve the dispute/);
  await call('POST', `utilities/bills/${bill.id}/dispute`, {});
  const part = await call('POST', `utilities/bills/${bill.id}/pay`, { amount: 6000, accountId: ctx.cash });
  assert.deepEqual([part.bill.status, Number(part.bill.paid)], ['partially_paid', 6000]);
  await call('POST', `finance/dues/${bill.dueId}/pay`, { amount: 10000, accountId: ctx.cash }); // paid from P&R instead
  const done = await call('GET', `r/utilities.bill/${bill.id}`);
  assert.deepEqual([done.status, Number(done.paid), !!done.paidAt], ['paid', 16000, true], 'bill follows its payable');

  const tr = await call('GET', `utilities/tracker?siteId=${site.id}&months=6`);
  const row = tr.rows.find((x: J) => x.id === conn.id);
  assert.equal(row.cells.find((c: J) => c.month === '2026-09').status, 'paid');
  assert.deepEqual([row.lastReading.reading, row.avgUnits, row.open], [10350, 350, 0]);
  const tb = await call('GET', 'finance/trial-balance');
  assert.equal(tb.totals[0][1], tb.totals[1][1], 'ledger still balances');
});

test('employee self-service: an Employee-role user sees exactly their own records', async () => {
  // Its own role (the company may have edited the stock Employee role): own-scope HR + expense requests, no branch access.
  const role = await call('POST', 'r/core.role', { name: `Self-service ${run}` });
  await call('PUT', `roles/${role.id}/permissions`, ['hrm.employee.view', 'hrm.payslip.view', 'finance.advance.view', 'finance.advance.create'].map((key) => ({ key, scope: 'own' })));
  const u = await call('POST', 'r/core.user', { name: `Self ${run}`, email: `self.${run}@erp.local`, password: 'Secret123' });
  await call('POST', `users/${u.id}/roles`, { roleIds: [role.id] });
  const emp = await call('POST', 'r/hrm.employee', { name: `Self ${run}`, userId: u.id });
  const admin = token;
  token = (await call('POST', 'auth/login', { login: `self.${run}@erp.local`, password: 'Secret123' })).accessToken;
  try {
    const mine = await call('GET', 'r/hrm.employee?pageSize=50');
    assert.deepEqual(mine.rows.map((r: J) => r.id), [emp.id], 'sees own employee record only');
    await call('GET', `r/hrm.employee/${emp.id}`);
    await assert.rejects(call('GET', `r/hrm.employee/${ctx.emp.id}`), /404/);
    assert.ok(Array.isArray(await call('GET', `hrm/leave/balance/${emp.id}`)), 'own leave balance');
    await assert.rejects(call('GET', `hrm/leave/balance/${ctx.emp.id}`), /404/);
    assert.equal((await call('GET', 'r/hrm.payslip?pageSize=50')).rows.filter((r: J) => r.employeeId !== emp.id).length, 0);
    // Regression: an employee's own advance — branch/department come from their employee record, typed text is ignored.
    const adv = await call('POST', 'r/finance.advance', { employeeId: emp.id, kind: 'expense', amount: '20000', purpose: 'Quetta advance', branchId: 'HQ', departmentId: 'x' });
    const empRec = await call('GET', `r/hrm.employee/${emp.id}`);
    assert.deepEqual([adv.branchId, adv.departmentId], [empRec.branchId, empRec.departmentId]);
  } finally { token = admin; }
});

test('expense claim: receipts optional by default; with a threshold set, submit needs them', async () => {
  const optional = await call('POST', 'r/finance.claim', { employeeId: ctx.emp.id, mode: 'direct', date: '2026-09-23', notes: `opt ${run}`, lines: [{ date: '2026-09-23', headId: ctx.fuelHead, amount: '9000' }] });
  const s0 = await call('POST', `r/finance.claim/${optional.id}/submit`);
  assert.ok(s0.status === 'pending' || s0.autoApproved, 'no receipt needed when the threshold is 0');
  const prevClaims = (await call('GET', 'admin/settings'))['finance.claims'];
  await call('PUT', 'admin/settings/finance.claims', { value: { receiptThreshold: 5000 } });
  try {
  const claim = await call('POST', 'r/finance.claim', { employeeId: ctx.emp.id, mode: 'direct', date: '2026-09-23', notes: `rcpt ${run}`, lines: [{ date: '2026-09-23', headId: ctx.fuelHead, amount: '6000' }, { date: '2026-09-23', headId: ctx.fuelHead, amount: '200' }] });
  assert.equal(Number(claim.total), 6200, 'draft saved without a receipt');
  await assert.rejects(call('POST', `r/finance.claim/${claim.id}/submit`), /Attach a receipt to 1 line/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('entityType', 'finance.claim'); fd.append('entityId', claim.id); fd.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png');
  const att = await (await fetch(`${API}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  const full = await call('GET', `r/finance.claim/${claim.id}`);
  await call('PATCH', `r/finance.claim/${claim.id}`, { lines: full.lines.map((l: J) => ({ date: l.date.slice(0, 10), headId: l.headId, amount: l.amount, tax: l.tax, attachmentId: Number(l.amount) > 5000 ? att.id : null })) });
  const sub = await call('POST', `r/finance.claim/${claim.id}/submit`);
  assert.ok(sub.status === 'pending' || sub.autoApproved);
  const policy = await call('GET', 'finance/claims/policy');
  assert.equal(policy.receiptThreshold, 5000);
  } finally {
    await call('PUT', 'admin/settings/finance.claims', { value: prevClaims ?? { receiptThreshold: 0 } });
  }
});

test('employee types are a managed list; Director is a type that sets the director flag', async () => {
  const code = `secondment_${run}`;
  await call('POST', 'r/core.masterdata', { type: 'employee_type', code, name: 'Secondment' });
  const meta = await call('GET', 'meta');
  const typeField = meta.resources.find((r: J) => r.key === 'hrm.employee').fields.find((f: J) => f.name === 'type');
  assert.equal(typeField.type, 'enum');
  assert.ok(typeField.options.includes('director') && typeField.options.includes(code), 'options come from Master Data');
  await assert.rejects(call('POST', 'r/hrm.employee', { name: `Bogus ${run}`, type: 'astronaut' }), /not in the employee type list/);
  const sec = await call('POST', 'r/hrm.employee', { name: `Sec ${run}`, type: code });
  assert.equal(sec.isDirector, false);
  const dir = await call('POST', 'r/hrm.employee', { name: `Dir ${run}`, type: 'director' });
  assert.equal(dir.isDirector, true, 'Director type sets the flag');
  assert.match((await call('GET', `r/finance.account/${dir.accountId}`)).name, /^Director – /);
  assert.equal((await call('PATCH', `r/hrm.employee/${dir.id}`, { type: 'permanent' })).isDirector, false, 'changing type clears it');
});

test('two-step approval: an approval admin approves it in one go (steps skipped, recorded)', async () => {
  const roles = (await call('GET', 'r/core.role?pageSize=100')).rows as J[];
  const acct = roles.find((r) => r.name === 'Accountant')!;
  const hr = roles.find((r) => r.name === 'HR Manager')!;
  const wf = await call('POST', 'r/core.workflow', { name: `Two step ${run}`, resource: 'finance.advance', priority: 98, steps: [{ name: 'Accounts', approverType: 'role', approverId: acct.id, mode: 'any' }, { name: 'HR', approverType: 'role', approverId: hr.id, mode: 'any' }] });
  try {
    const adv = await call('POST', 'r/finance.advance', { employeeId: ctx.emp.id, kind: 'expense', amount: '10', purpose: `two ${run}` });
    const sub = await call('POST', `r/finance.advance/${adv.id}/submit`);
    const r = await call('POST', `approvals/${sub.requestId}/approve`, {});
    assert.equal(r.status, 'approved', 'one admin approval finishes both steps');
    const hist = await call("GET", `r/finance.advance/${adv.id}/approvals`);
    assert.match(hist.at(-1).actions.at(-1).comment, /admin approval — steps 2–2 skipped/);
  } finally { await call('DELETE', `r/core.workflow/${wf.id}`); }
});

test('employee status is automatic: approved leave today → on leave; approved resignation → resigned', async () => {
  const emp = await call('POST', 'r/hrm.employee', { name: `Auto ${run}` });
  assert.equal(emp.status, 'active');
  const today = new Date().toISOString().slice(0, 10);
  const lt = (await list('hrm.leavetype')).find((t) => Number(t.daysPerYear) > 5)!;
  const leave = await call('POST', 'r/hrm.leave', { employeeId: emp.id, leaveTypeId: lt.id, from: today, to: today, days: '1', reason: 'auto status' });
  await approveAll('hrm.leave', leave.id);
  assert.equal((await call('GET', `r/hrm.employee/${emp.id}`)).status, 'on_leave');
  await call('PATCH', `r/hrm.employee/${emp.id}`, { status: 'active' });
  assert.equal((await call('GET', `r/hrm.employee/${emp.id}`)).status, 'on_leave', 'status cannot be typed in');
  const ev = await call('POST', 'r/hrm.event', { employeeId: emp.id, type: 'resignation', date: today });
  await approveAll('hrm.event', ev.id);
  assert.equal((await call('GET', `r/hrm.employee/${emp.id}`)).status, 'resigned');
});

test('standard report library: every report runs (data + Excel) for a date range', async () => {
  const list = await call('GET', 'reports/standard');
  assert.ok(list.length >= 30, `library has ${list.length} reports`);
  const bad: string[] = [];
  for (const r of list) {
    try {
      const out = await call('GET', `reports/standard/${r.key}?from=2026-01-01&to=2026-12-31`);
      if (!Array.isArray(out.rows) || !out.columns.length) bad.push(`${r.key}: empty definition`);
    } catch (e) { bad.push(`${r.key}: ${(e as Error).message.slice(0, 160)}`); }
  }
  assert.deepEqual(bad, []);
  const x = await fetch(`${API}/reports/standard/rep-jobs-by-status?format=xlsx`, { headers: { Authorization: `Bearer ${token}` } });
  assert.match(x.headers.get('content-type') ?? '', /spreadsheet/);
  const inv = await call('GET', 'reports/standard/rep-sales-by-customer?from=2026-01-01&to=2026-12-31');
  assert.ok(inv.columns.includes('balance') && inv.rows.every((r: J) => r.balance === r.sum_total - r.sum_paid), 'calculated balance column');
});

test('intake-level quotation, invoice and delivery cover all units; no unit is billed twice', async () => {
  const cust = await call('POST', 'r/sales.customer', { name: `Signals Unit ${run}` });
  const { intake, jobs } = await call('POST', 'repair/intakes', { customerId: cust.id, items: [
    { productType: 'Handheld radio', brand: 'Harris', model: 'RF-7850', serial: `A-${run}`, fault: 'Low RF output power' },
    { productType: 'Gateway / router', brand: 'Cisco', model: 'IR829', serial: `B-${run}`, fault: 'Network link down' },
  ] });
  const [u1, u2] = jobs;
  await call('POST', `repair/jobs/${u1.id}/diagnose`, { findings: 'PA module degraded', parts: [{ productId: ctx.screen.id, qty: 1 }], labor: [{ serviceId: ctx.labor, qty: 1 }] });

  const iq = await call('POST', `repair/intakes/${intake.id}/quotation`);
  assert.equal(iq.units, 2);
  const q = await call('GET', `r/repair.quotation/${iq.id}`);
  assert.equal(q.intakeId, intake.id);
  assert.ok(q.lines.filter((l: J) => l.jobId === u1.id).length === 2, 'unit 1 diagnosis lines');
  assert.ok(q.lines.some((l: J) => l.jobId === u2.id && l.description.startsWith(u2.number)), 'unit 2 placeholder line');
  assert.ok(q.lines.every((l: J) => l.description.startsWith(u1.number) || l.description.startsWith(u2.number)), 'every line names its job');

  const d = await call('POST', `repair/quotations/${iq.id}/decision`, { accepted: true, via: 'signature' });
  assert.equal(d.reserved, 1);
  assert.deepEqual(d.unchangedJobs, [u2.id], 'undiagnosed unit is not force-approved');
  assert.equal((await call('GET', `r/repair.job/${u1.id}`)).status, 'approved');

  await call('POST', `repair/jobs/${u1.id}/issue-parts`, { warehouseId: ctx.wh });
  await call('POST', `repair/jobs/${u1.id}/test`, { pass: true, rfPowerW: 5 });

  const inv = await call('POST', `repair/intakes/${intake.id}/invoice`);
  assert.equal(inv.intakeId, intake.id);
  assert.equal(inv.units, 1);
  assert.ok(inv.lines.every((l: J) => l.jobId === u1.id));
  await assert.rejects(call('POST', `repair/jobs/${u1.id}/invoice`, {}), /already invoiced/);
  await assert.rejects(call('POST', `repair/intakes/${intake.id}/invoice`), /ready to invoice|already invoiced/);

  const dor = await call('POST', `repair/intakes/${intake.id}/deliver`, { receivedBy: 'Maj. Khan' });
  assert.equal(dor.units, 1);
  assert.equal(dor.waiting, 1);
  assert.equal((await call('GET', `r/repair.job/${u1.id}`)).status, 'delivered');
  const related = await list('repair.invoice', { intakeId: intake.id });
  assert.equal(related.length, 1);
  const tb = await call('GET', 'finance/trial-balance');
  assert.equal(tb.totals[0][1], tb.totals[1][1]);
});

test('serial tracking works standalone: register by hand, skip duplicates, track moves', async () => {
  const a = `MAN-A-${run}`, b = `MAN-B-${run}`;
  const r1 = (await call('POST', 'serials/register', { serials: [a, b, a], itemName: "Field gateway", brand: "Acme", location: "HQ rack 2" }));
  assert.deepEqual(r1.created, [a, b]);
  const r2 = (await call("POST", "serials/register", { serials: [b] }));
  assert.deepEqual([r2.created, r2.existing], [[], [b]], 'already-registered serial skipped');
  const item = (await list('serials.item', { serial: a }))[0];
  assert.equal(item.productId, null, 'no inventory product needed');
  await call('PATCH', `r/serials.item/${item.id}`, { status: 'demo', location: 'Site B', holder: 'Field team 3' });
  const h = (await call("GET", `serials/lookup?serial=${a}`)).history.map((e: J) => `${e.title}: ${e.detail}`);
  assert.equal(h.length, 2);
  assert.match(h[0], /^Registered: Field gateway · Acme · in stock · HQ rack 2/);
  assert.match(h[1], /Status: in stock → demo · Location: HQ rack 2 → Site B · Holder: — → Field team 3/);
});

test('serial custody: issue → return → sell → RMA out and back to the customer; scrapped units stay put', async () => {
  const sn = `CUS-${run}`;
  await call('POST', 'serials/register', { serials: [sn], itemName: 'Handheld radio', brand: 'Motorola', model: 'APX 6000' });
  const id = (await list('serials.item', { serial: sn }))[0].id;
  const act = (b: J) => call('POST', `serials/${id}/action`, b);
  await assert.rejects(act({ action: 'issue' }), /issued to/);
  assert.equal((await act({ action: 'issue', holder: 'Field team 3', location: 'Site B' })).status, 'issued');
  assert.equal((await act({ action: 'return', note: 'back from site' })).holder, null);
  await assert.rejects(act({ action: 'sell' }), /customer/);
  const sold = await act({ action: 'sell', customerId: ctx.customer.id, warrantyUntil: '2027-10-16' });
  assert.equal(sold.status, 'sold');
  assert.ok((await call('GET', `r/serials.item/${id}`)).soldAt, 'sale date recorded');
  await assert.rejects(act({ action: 'rma_in' }), /not out for RMA/);
  await assert.rejects(act({ action: 'rma' }), /RMA number/);
  assert.equal((await act({ action: 'rma', note: 'No TX, RMA #42' })).status, 'rma');
  assert.equal((await act({ action: 'rma_in' })).status, 'sold', 'back to the customer who owns it');
  const h = (await call('GET', `serials/lookup?serial=${sn}`)).history as J[];
  assert.deepEqual(h.map((e) => e.title), ['Registered', 'Issued', 'Returned to stock', 'Sold / handed to customer', 'Sent for RMA', 'Back from RMA']);
  assert.ok(h.slice(1).every((e) => e.by), 'each step says who did it');
  await act({ action: 'scrap', note: 'water damage' });
  await assert.rejects(act({ action: 'issue', holder: 'x' }), /scrapped/);
  const sum = await call('GET', 'serials/summary');
  assert.ok(sum.total >= 1 && sum.byStatus.scrapped >= 1 && typeof sum.expired === 'number');
});

test('serial tracking: supplier, sale, warranty, full history, intake auto-warranty, bulk', async () => {
  const sn = `SN2-${run}`; // received on a PO, sent on demo, sold (gatepass test)
  const item = (await list('serials.item', { serial: sn }))[0];
  assert.equal(item.status, 'sold');
  assert.ok(item.vendorId, 'supplier recorded at goods receipt');
  assert.equal(item.customerId, ctx.customer.id, 'customer recorded at sale');
  assert.ok(item.warrantyUntil, 'warranty end set at sale');

  const l = await call('GET', `serials/lookup?serial=${sn}`);
  assert.equal(l.warranty.state, 'active');
  const kinds = l.history.map((h: J) => h.title);
  assert.ok(kinds.includes('Received into stock'), 'receipt');
  assert.equal(kinds.filter((t: string) => t === 'Sent out on demo').length, 1, 'demo transfer shown once');
  assert.match(l.history.find((h: J) => h.title === 'Sent out on demo').detail, /→/);
  assert.ok(kinds.includes('Sold'), 'sale');
  assert.ok(kinds.some((t: string) => t.startsWith('Gatepass ')), 'gatepass');

  const { jobs } = await call('POST', 'repair/intakes', { customerId: ctx.customer.id, items: [{ productType: 'Handheld radio', serial: sn, fault: 'No receive' }] });
  assert.equal((await call('GET', `r/repair.job/${jobs[0].id}`)).warranty, true, 'intake auto-flags warranty');
  assert.ok((await call('GET', `serials/lookup?serial=${sn}`)).history.some((h: J) => h.title === `Repair job ${jobs[0].number}`));

  const b = await call('POST', 'serials/bulk', { serials: [sn, `SN1-${run}`, `NOPE-${run}`] });
  assert.equal(b.rows.length, 2);
  assert.deepEqual(b.unknown, [`NOPE-${run}`]);
  await assert.rejects(call('GET', `serials/lookup?serial=NOPE-${run}`), /404/);
  const scan = await call('GET', `search/scan?code=${sn}`);
  assert.ok(scan.some((h: J) => h.entityType === 'serials.item'));
});

test('catalog: brochure (HTML + PDF) and PowerPoint for one or many items', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const a = await call('POST', 'r/catalog.item', {
    name: `Tactical Radio ${run}`, kind: 'product', category: 'Radios', tagline: 'Secure voice & data in the field',
    summary: 'Wideband manpack radio for tactical networks.', features: '- Wideband 30–512 MHz\n- AES-256 encryption\n- MIL-STD-810G',
    specs: 'Frequency: 30–512 MHz\nOutput power = 20 W\nIP67 rated', applications: 'Border patrol\nConvoy comms', benefits: 'Interoperable\nLong battery life',
    price: '450000', showPrice: true, status: 'published',
    customHtml: '<h2 class="spot">Field-proven</h2><p onmouseover="x()">Deployed in 12 countries</p><script>bad()</script>', customCss: 'h2.spot { color: rgb(1, 2, 3) }',
  });
  assert.match(a.code, /^CAT-/);
  assert.equal(a.customHtml, '<h2 class="spot">Field-proven</h2><p>Deployed in 12 countries</p>', 'item HTML sanitised on save');
  const rich = await call('PATCH', `r/catalog.item/${a.id}`, { summary: '<p><b>Wideband</b> manpack radio.</p><img src=x onerror=alert(1)>' });
  assert.equal(rich.summary, '<p><b>Wideband</b> manpack radio.</p><img src=x>', 'rich summary sanitised');
  assert.match((await call('GET', `catalog/brochure?items=c:${a.id}&theme=modern`)).text, /<div class="lead"><div class="rich"><p><b>Wideband<\/b> manpack radio\.<\/p>/, 'rich summary rendered as HTML');
  {
    const one = (await call('GET', `catalog/brochure?items=c:${a.id}&theme=modern`)).text;
    assert.equal((one.match(/<section class="page /g) ?? []).length, 2, 'a single item is a two-page brochure');
    assert.match(one, /class="page s1 item dark ci-0">/, "modern single item is the dark variant");
    assert.match(one, /class="page s2 item dark ci-0">[\s\S]*<div class="overview custom-body"><h2 class="spot">Field-proven<\/h2>/, 'item HTML replaces the overview on page 2');
    assert.match(one, /\.ci-0 \{\nh2\.spot \{ color: rgb\(1, 2, 3\) \}\n\}/, 'item CSS scoped to the item class');
    assert.ok(!(await call('GET', `catalog/brochure?items=c:${a.id}&theme=modern&custom=0`)).text.includes('Field-proven'), 'switch turns it off');
    // Editorial theme (default): landscape, "our product 01 //", black panels, page squares; one product = 2 pages.
    const ed = (await call('GET', `catalog/brochure?items=c:${a.id}`)).text;
    assert.equal((ed.match(/<section class="pg /g) ?? []).length, 2, 'editorial single product = two pages');
    assert.match(ed, /@page\{size:297mm 210mm/);
    assert.match(ed, /<span class="ey">Radios · product<\/span><h2>Tactical Radio /, 'category line + product name, no "our product 01 //"');
    assert.ok(!/our product|\/\/</.test(ed), 'no gimmick headings');
    assert.match(ed, /class="panel"><h4>Key features<\/h4>/);
    assert.match(ed, /class="pn [lr]">01<\/span>/);
    const edPdf = Buffer.from(await (await fetch(`${API}/catalog/brochure?items=c:${a.id}&format=pdf`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer()).toString('latin1');
    assert.equal((edPdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length, 2, 'editorial PDF is two pages');
  }
  const fd = new FormData();
  fd.append('entityType', 'catalog.item');
  fd.append('entityId', a.id);
  fd.append('file', new Blob([png], { type: 'image/png' }), 'hero.png');
  const img = await (await fetch(`${API}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })).json();
  await call('PATCH', `r/catalog.item/${a.id}`, { images: [img.id] });
  const b = await call('POST', 'r/catalog.item', { name: `Gateway Solution ${run}`, kind: 'solution', summary: 'Edge gateway integration.', features: 'LTE failover\nVPN' });

  const html = (await call('GET', `catalog/brochure?ids=${a.id}&theme=modern`)).text;
  assert.match(html, new RegExp(`Tactical Radio ${run}`));
  assert.match(html, /<b>30–512 MHz<\/b><span>Frequency<\/span>/, 'lead specs become stat tiles');
  assert.match(html, /data:image\/png;base64,/, 'hero image embedded');
  assert.match(html, /450,000/, 'price shown when enabled on the item');
  // Mixed selection: two catalog items + an inventory product, in the chosen order, with options.
  const items = `c:${a.id},c:${b.id},p:${ctx.screen.id}`;
  const multi = (await call('GET', `catalog/brochure?items=${items}&title=Signals%20Offer&theme=light&prices=hide`)).text;
  assert.match(multi, /Signals Offer/);
  assert.match(multi, /Contents/);
  assert.match(multi, /Comparison/);
  assert.match(multi, new RegExp(`iPhone 13 Screen|${ctx.screen.name}`), 'inventory product included');
  assert.ok(!multi.includes('450,000'), 'prices hidden');
  assert.ok(multi.indexOf(`Tactical Radio ${run}`) < multi.indexOf(`Gateway Solution ${run}`), 'order kept');

  const pdf = await fetch(`${API}/catalog/brochure?items=${items}&format=pdf`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  // Company introduction + locations (profile set once, reused everywhere)
  await assert.rejects(call('PUT', 'catalog/about', { photo: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG, JPEG or WebP/);
  // The company's real profile is put back at the end of this test.
  const realAbout = await call('GET', 'catalog/about');
  try {
  await call('PUT', 'catalog/about', {
    intro: 'Demo Company designs, integrates and supports secure communication systems.', mission: 'Reliable comms when it matters most.',
    highlights: 'Founded: 2005\nClients: 300+\nEngineers: 45', certifications: 'ISO 9001:2015\nISO 27001',
    locations: 'Head Office | Blue Area, Islamabad | +92 51 111 222 | info@demo.pk\nLahore Branch | Gulberg III, Lahore | +92 42 333 444',
    photo: `data:image/png;base64,${png.toString('base64')}`,
    customCss: '.custom-body h2 { color: #0f766e }', customHtml: '<h2>Why choose us</h2><p onclick="steal()">24/7 support</p><script>steal()</script>',
  });
  const saved = await call('GET', 'catalog/about');
  assert.equal(saved.customHtml, '<h2>Why choose us</h2><p>24/7 support</p>', 'scripts and handlers stripped on save');
  const styled = (await call('GET', `catalog/brochure?items=${items}&theme=modern`)).text;
  assert.match(styled, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.match(styled, /class="page custom"><div class="custom-body"><h2>Why choose us<\/h2>/);
  assert.ok(styled.indexOf('page custom') < styled.indexOf('page back') && styled.includes('.custom-body h2 { color: #0f766e }'));
  assert.ok(!(await call('GET', `catalog/brochure?items=${items}&theme=modern&custom=0`)).text.includes('Why choose us'), 'custom page is optional');
  const styledPdf = await fetch(`${API}/catalog/brochure?items=${items}&format=pdf`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(styledPdf.headers.get('content-type'), 'application/pdf', 'PDF still renders with the network blocked');
  const edMulti = (await call('GET', `catalog/brochure?items=${items}`)).text;
  assert.match(edMulti, /class="pg cover"/);
  assert.match(edMulti, /<span class="ey">About us<\/span>/);
  for (const [per, n] of [['2', 2], ['3', 1]] as const) {
    const cards = (await call('GET', `catalog/brochure?items=${items}&perPage=${per}`)).text;
    assert.equal((cards.match(/class="pg cardpage c/g) ?? []).length, n, `${per} products per page`);
    assert.equal((cards.match(/<article class="card/g) ?? []).length, 3);
  }
  assert.match(edMulti, /class="pg backpage"/);
  const withAbout = (await call('GET', `catalog/brochure?items=${items}&theme=modern`)).text;
  const co = (await call('GET', 'meta')).company.name;
  assert.ok(withAbout.includes(`About ${co}`));
  assert.match(withAbout, /<b>300\+<\/b><span>Clients<\/span>/);
  assert.match(withAbout, /Our locations/);
  assert.match(withAbout, /class="loc hq"><span class="pin">HQ<\/span>\s*<b>Head Office<\/b>/);
  const custom = (await call('GET', `catalog/brochure?items=${items}&theme=modern&intro=${encodeURIComponent('Prepared especially for the Signals Directorate.')}`)).text;
  assert.match(custom, /Prepared especially for the Signals Directorate\./);
  assert.ok(!custom.includes('designs, integrates and supports'), 'per-document intro replaces the standard one');
  const without = (await call('GET', `catalog/brochure?items=${items}&theme=modern&about=0&locations=0&compare=0`)).text;
  assert.ok(!without.includes(`About ${co}`) && !without.includes('Our locations'));
  assert.ok(!without.includes('At a glance'), 'comparison is optional');
  const ordered = (await call('GET', `catalog/brochure?items=${items}&theme=modern`)).text;
  assert.ok(ordered.indexOf('class="page compare') > ordered.lastIndexOf('class="page item') && ordered.indexOf('class="page compare') < ordered.indexOf('class="page back'), 'comparison is the last page before the back cover');
  const noCmp = await fetch(`${API}/catalog/presentation?items=${items}&compare=0`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(new Set(Buffer.from(await noCmp.arrayBuffer()).toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g)).size, 13, 'deck without comparison slide');

  const res = await fetch(`${API}/catalog/presentation?items=${items}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.match(res.headers.get('content-type') ?? '', /presentationml/);
  const deck = Buffer.from(await res.arrayBuffer());
  assert.equal(deck.subarray(0, 2).toString(), 'PK');
  const slides = new Set(deck.toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g));
  // title + about + locations + agenda + A(4) + B(2) + product(2) + comparison + contact
  assert.equal(slides.size, 14);
  await assert.rejects(call('GET', 'catalog/brochure?ids='), /Select at least one/);
  } finally {
    await call('PUT', 'catalog/about', realAbout);
  }
});
