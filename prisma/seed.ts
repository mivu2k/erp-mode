import { DataScope, Prisma, PrismaClient } from '@prisma/client';
import { ACTIONS, ALL_PERMISSIONS } from '../packages/shared/src';
import { hashPassword } from '../apps/api/src/platform/password';

const prisma = new PrismaClient();

/** Role defaults: [pattern, scope]. Pattern is a permission key with `*` wildcards. Everything stays editable in Admin. */
const ROLES: Record<string, [string, DataScope][]> = {
  'Super Admin': [['*', 'all']],
  Admin: [['*', 'all']],
  Director: [['*.view', 'all'], ['*.approve', 'all'], ['*.export', 'all'], ['*.print', 'all'], ['reports.*', 'all'], ['finance.*', 'all'], ['core.approval.*', 'all']],
  'HR Manager': [['hrm.*', 'all'], ['core.department.*', 'all'], ['core.designation.*', 'all'], ['core.masterdata.view', 'all'], ['core.branch.view', 'all'], ['core.user.view', 'all'], ['core.user.create', 'all'], ['finance.advance.view', 'all'], ['finance.loan.view', 'all'], ['finance.loan.approve', 'all'], ['finance.statement.view', 'all'], ['reports.builder.view', 'all']],
  Accountant: [['finance.*', 'all'], ['payables.*', 'all'], ['utilities.*', 'all'], ['serials.item.view', 'all'], ['hrm.payroll.*', 'all'], ['hrm.payslip.*', 'all'], ['hrm.employee.view', 'all'], ['hrm.salary.*', 'all'], ['purchase.bill.*', 'all'], ['purchase.vendor.view', 'all'], ['repair.invoice.*', 'all'], ['repair.creditnote.*', 'all'], ['sales.customer.view', 'all'], ['core.masterdata.view', 'all'], ['reports.*', 'all'], ['inventory.stock.*', 'all']],
  Employee: [
    ['hrm.employee.view', 'own'], ['hrm.leave.view', 'own'], ['hrm.leave.create', 'own'], ['hrm.leave.update', 'own'], ['hrm.leavetype.view', 'all'],
    ['hrm.correction.view', 'own'], ['hrm.correction.create', 'own'], ['hrm.correction.update', 'own'], ['hrm.attendance.view', 'own'], ['hrm.punch.view', 'own'],
    ['hrm.payslip.view', 'own'], ['hrm.payslip.print', 'own'], ['hrm.task.view', 'own'], ['hrm.task.update', 'own'], ['hrm.dailyreport.view', 'own'], ['hrm.dailyreport.create', 'own'],
    ['finance.advance.view', 'own'], ['finance.advance.create', 'own'], ['finance.advance.update', 'own'], ['finance.claim.view', 'own'], ['finance.claim.create', 'own'], ['finance.claim.update', 'own'],
    ['finance.loan.view', 'own'], ['finance.loan.create', 'own'], ['finance.loan.update', 'own'], ['finance.voucher.view', 'own'], ['finance.voucher.print', 'own'],
    ['core.masterdata.view', 'all'], ['fleet.vehicle.view', 'all'],
  ],
  'Repair Manager': [['catalog.*', 'all'], ['repair.*', 'all'], ['serials.item.view', 'all'], ['serials.item.update', 'all'], ['sales.customer.*', 'all'], ['inventory.product.view', 'all'], ['inventory.stock.view', 'all'], ['inventory.warehouse.view', 'all'], ['inventory.movement.create', 'all'], ['hrm.employee.view', 'all'], ['purchase.requisition.*', 'all'], ['core.masterdata.view', 'all'], ['finance.account.view', 'all'], ['finance.payment.create', 'all']],
  Technician: [['serials.item.view', 'all'], ['repair.job.view', 'own'], ['repair.job.update', 'own'], ['repair.job.print', 'own'], ['repair.quotation.view', 'branch'], ['repair.quotation.create', 'branch'], ['sales.customer.view', 'all'], ['inventory.product.view', 'all'], ['inventory.warehouse.view', 'all'], ['purchase.requisition.create', 'own'], ['purchase.requisition.view', 'own'], ['core.masterdata.view', 'all']],
  'Front Desk': [['catalog.item.view', 'all'], ['catalog.item.print', 'all'], ['catalog.item.export', 'all'], ['serials.item.view', 'all'], ['repair.job.view', 'branch'], ['repair.job.create', 'branch'], ['repair.job.update', 'branch'], ['repair.job.print', 'branch'], ['repair.intake.*', 'branch'], ['repair.quotation.view', 'branch'], ['repair.quotation.update', 'branch'], ['repair.invoice.view', 'branch'], ['repair.invoice.create', 'branch'], ['repair.invoice.print', 'branch'], ['repair.delivery.*', 'branch'], ['sales.customer.*', 'all'], ['finance.payment.create', 'branch'], ['finance.account.view', 'all'], ['core.masterdata.view', 'all']],
  'Store Keeper': [['inventory.*', 'all'], ['serials.*', 'all'], ['purchase.receipt.*', 'all'], ['purchase.order.view', 'all'], ['purchase.vendor.view', 'all'], ['gatepass.pass.view', 'all'], ['gatepass.pass.create', 'all'], ['core.masterdata.view', 'all']],
  'Purchase Officer': [['purchase.*', 'all'], ['inventory.product.view', 'all'], ['inventory.stock.view', 'all'], ['inventory.warehouse.view', 'all'], ['core.masterdata.view', 'all']],
  'Fleet Manager': [['fleet.*', 'all'], ['repair.job.create', 'all'], ['repair.job.view', 'all'], ['hrm.employee.view', 'all'], ['hrm.document.*', 'all'], ['purchase.vendor.view', 'all']],
  Driver: [['fleet.vehicle.view', 'all'], ['fleet.trip.view', 'own'], ['fleet.trip.create', 'own'], ['fleet.trip.update', 'own'], ['fleet.fuel.view', 'own'], ['fleet.fuel.create', 'all']],
  'Security Guard': [['serials.item.view', 'all'], ['gatepass.pass.view', 'all'], ['gatepass.check.*', 'all']],
  'Facilities Officer': [['utilities.site.*', 'all'], ['utilities.connection.*', 'all'], ['utilities.reading.*', 'all'], ['utilities.bill.view', 'all'], ['utilities.bill.create', 'all'], ['utilities.bill.update', 'all'], ['utilities.bill.print', 'all'], ['purchase.vendor.view', 'all'], ['finance.account.view', 'all'], ['core.branch.view', 'all']],
  Viewer: [['*.view', 'all']],
};

const match = (pattern: string, key: string) => new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '[^]*')}$`).test(key);

async function main() {
  const company = (await prisma.company.findFirst()) ?? (await prisma.company.create({ data: { name: 'Demo Company', address: 'Islamabad', phone: '+92 51 0000000', branding: { primary: '#3b82f6', mode: 'dark', density: 'comfortable' } } }));
  const c = company.id;
  const branch = await prisma.branch.upsert({ where: { companyId_code: { companyId: c, code: 'HQ' } }, update: {}, create: { companyId: c, code: 'HQ', name: 'Head Office' } });

  // ─── Permissions & roles ───
  for (const key of ALL_PERMISSIONS) await prisma.permission.upsert({ where: { key }, update: {}, create: { key, module: key.split('.')[0] } });
  const perms = await prisma.permission.findMany();
  const roleIds: Record<string, string> = {};
  for (const [name, rules] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({ where: { companyId_name: { companyId: c, name } }, update: {}, create: { companyId: c, name, isSystem: true } });
    roleIds[name] = role.id;
    const scoped = new Map<string, DataScope>();
    for (const p of perms) for (const [pattern, scope] of rules) if (match(pattern, p.key) && !scoped.has(p.id)) scoped.set(p.id, scope);
    await prisma.rolePermission.createMany({ data: [...scoped].map(([permissionId, scope]) => ({ roleId: role.id, permissionId, scope })), skipDuplicates: true });
  }

  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@erp.local';
  const admin = await prisma.user.upsert({
    where: { email }, update: {},
    create: { companyId: c, branchId: branch.id, email, username: 'admin', name: 'Super Admin', passwordHash: await hashPassword(process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345') },
  });
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: admin.id, roleId: roleIds['Super Admin'] } }, update: {}, create: { userId: admin.id, roleId: roleIds['Super Admin'] } });

  // ─── Comms-equipment workshop master data (idempotent: adds missing codes only) ───
  const ensure = async (type: string, rows: [string, string, Prisma.InputJsonValue?][]) => {
    for (const [i, [code, name, value]] of rows.entries()) {
      if (await prisma.masterData.findFirst({ where: { companyId: c, type, code } })) continue;
      await prisma.masterData.create({ data: { companyId: c, type, code, name, value: value ?? Prisma.JsonNull, sort: i } });
    }
  };
  await ensure('equipment_type', [
    ['HH-RADIO', 'Handheld radio'], ['VEH-RADIO', 'Vehicle / mobile radio'], ['BASE', 'Base station'], ['MANPACK', 'Manpack radio'],
    ['REPEATER', 'Repeater'], ['SATCOM', 'SATCOM terminal'], ['CAMERA', 'Camera'], ['IPCAM', 'IP camera / NVR'], ['GATEWAY', 'Gateway / router'],
    ['ANTENNA', 'Antenna'], ['AMP', 'RF amplifier'], ['PSU', 'Power supply / battery'], ['CRYPTO', 'Crypto / COMSEC device'], ['OTHER', 'Other'],
  ]);
  await ensure('fault', [
    ['NO-TX', 'No transmit'], ['NO-RX', 'No receive'], ['LOW-PWR', 'Low RF output power'], ['DEAF', 'Poor receive sensitivity'], ['NO-POWER', 'Does not power on'],
    ['PTT', 'PTT / keypad fault'], ['AUDIO', 'No / distorted audio'], ['DISPLAY', 'Display fault'], ['FW', 'Firmware / boot failure'], ['CHARGE', 'Battery not charging'],
    ['CONNECTOR', 'Antenna connector damaged'], ['WATER', 'Water ingress'], ['VIDEO', 'No video / image'], ['LINK', 'Network link down'],
  ]);
  await ensure('service_rate', [
    ['LABOR-STD', 'Standard Labor (per job)', { rate: 1500 }], ['BENCH', 'Bench test & diagnosis', { rate: 2500 }], ['ALIGN', 'Alignment / RF tuning', { rate: 6000 }], ['FW', 'Firmware upgrade / programming', { rate: 3000 }],
    ['BOARD', 'Board-level repair', { rate: 12000 }], ['RFPA', 'RF / PA module replacement', { rate: 8000 }], ['ANT', 'Antenna / connector repair', { rate: 2000 }],
    ['BATT', 'Battery refurbishment', { rate: 3500 }], ['CAM-CAL', 'Camera calibration / lens service', { rate: 5000 }], ['GW-CONF', 'Gateway configuration / reset', { rate: 2500 }],
  ]);
  await ensure('product_category', [
    ['RF-MOD', 'RF modules & PA boards'], ['MAINBOARD', 'Main / logic boards'], ['BATTERY', 'Batteries'], ['ANTENNA', 'Antennas'],
    ['CONN', 'Connectors & cables'], ['AUDIO', 'Handsets, mics & speakers'], ['LENS', 'Lenses & sensors'], ['ENCLOSURE', 'Housings & knobs'],
  ]);
  await ensure('accessory', [
    ['BATT', 'Battery'], ['ANT', 'Antenna'], ['CHG', 'Charger / cradle'], ['MIC', 'Handset / speaker-mic'], ['CLIP', 'Belt clip'],
    ['CABLE', 'Cables'], ['CASE', 'Carry case'], ['PSU', 'Power adapter'], ['MOUNT', 'Mount / bracket'], ['DOCS', 'Manual / documents'],
  ]);

  // ─── Approval chains added after first release (idempotent by name) ───
  const ensureWf = async (resource: string, name: string, steps: object[], conditions: object | null = null, priority = 0) => {
    if (await prisma.workflowDefinition.findFirst({ where: { companyId: c, resource, name } })) return;
    await prisma.workflowDefinition.create({ data: { companyId: c, resource, name, steps: steps as Prisma.InputJsonValue, conditions: conditions ?? Prisma.JsonNull, priority } });
  };
  await ensureWf('finance.loan', 'Salary advance / loan', [{ name: 'Manager', approverType: 'manager' }, { name: 'HR', approverType: 'role', approverId: roleIds['HR Manager'] }, { name: 'Accounts', approverType: 'role', approverId: roleIds.Accountant }]);
  await ensureWf('finance.voucher', 'Payment release (large)', [{ name: 'Accounts review', approverType: 'role', approverId: roleIds.Accountant }, { name: 'Director release', approverType: 'role', approverId: roleIds.Director }], { minAmount: 50000 }, 10);
  await ensureWf('finance.voucher', 'Payment release', [{ name: 'Accounts review', approverType: 'role', approverId: roleIds.Accountant }]);

  // Reports split for separate expense-advance / loan screens (idempotent).
  const adminUser = await prisma.user.findFirst({ where: { companyId: c, email } });
  for (const r of await prisma.savedReport.findMany({ where: { companyId: c, name: 'Advances outstanding' } })) {
    const d = r.definition as { columns?: string[] };
    if (d.columns?.includes('kind')) await prisma.savedReport.update({ where: { id: r.id }, data: { definition: { ...d, columns: d.columns.filter((x) => x !== 'kind') } as Prisma.InputJsonValue } });
  }
  if (!(await prisma.savedReport.findFirst({ where: { companyId: c, name: 'Loans outstanding' } }))) {
    await prisma.savedReport.create({ data: { companyId: c, name: 'Loans outstanding', createdById: adminUser?.id, sharedRoles: [roleIds.Admin, roleIds.Director, roleIds.Accountant, roleIds['HR Manager']],
      definition: { resource: 'finance.loan', filters: { status: 'disbursed' }, columns: ['number', 'employeeId', 'amount', 'installmentAmount', 'recovered'], calc: [{ name: 'outstanding', a: 'amount', op: '-', b: 'recovered' }] } } });
  }

  if (await prisma.account.count({ where: { companyId: c } })) return console.log(`Already seeded. Login: ${email}`);

  // ─── Chart of accounts ───
  const acc: Record<string, string> = {};
  const add = async (key: string, code: string, name: string, type: string, parent?: string, extra: Partial<Prisma.AccountUncheckedCreateInput> = {}) => {
    acc[key] = (await prisma.account.create({ data: { companyId: c, code, name, type, parentId: parent ? acc[parent] : null, ...extra } })).id;
  };
  await add('assets', '1000', 'Assets', 'asset', undefined, { isGroup: true });
  await add('cashGroup', '1100', 'Cash & Bank', 'asset', 'assets', { isGroup: true });
  await add('cash', '1110', 'Petty Cash – HQ', 'asset', 'cashGroup', { isCash: true, branchId: branch.id });
  await add('bank', '1120', 'Bank – Current Account', 'asset', 'cashGroup', { isBank: true });
  await add('advances', '1300', 'Employee & Director Accounts', 'asset', 'assets', { isGroup: true });
  await add('receivable', '1400', 'Accounts Receivable', 'asset', 'assets');
  await add('inventory', '1500', 'Inventory', 'asset', 'assets');
  await add('liabilities', '2000', 'Liabilities', 'liability', undefined, { isGroup: true });
  await add('payable', '2100', 'Accounts Payable', 'liability', 'liabilities');
  await add('salaryPayable', '2200', 'Salary Payable', 'liability', 'liabilities');
  await add('deductionsPayable', '2300', 'Payroll Deductions Payable', 'liability', 'liabilities');
  await add('salesTax', '2400', 'Sales Tax Payable', 'liability', 'liabilities');
  await add('equity', '3000', 'Equity', 'equity', undefined, { isGroup: true });
  await add('directorCapital', '3100', 'Director Capital', 'equity', 'equity');
  await add('income', '4000', 'Income', 'income', undefined, { isGroup: true });
  await add('laborIncome', '4100', 'Repair Labor Income', 'income', 'income');
  await add('partsIncome', '4200', 'Parts & Product Sales', 'income', 'income');
  await add('salesReturns', '4900', 'Sales Returns & Refunds', 'income', 'income');
  await add('expenses', '5000', 'Expenses', 'expense', undefined, { isGroup: true });
  await add('cogs', '5100', 'Cost of Goods Sold', 'expense', 'expenses');
  await add('salaryExpense', '5200', 'Salaries & Wages', 'expense', 'expenses');
  await add('empExp', '5300', 'Employee Expenses', 'expense', 'expenses', { isGroup: true });
  await add('fuel', '5310', 'Fuel', 'expense', 'empExp');
  await add('travel', '5320', 'Travel', 'expense', 'empExp');
  await add('utilities', '5330', 'Utilities', 'expense', 'empExp');
  await add('repairsExp', '5340', 'Repairs & Maintenance', 'expense', 'empExp');
  await add('office', '5350', 'Office Supplies', 'expense', 'empExp');
  await add('dirExp', '5900', 'Director Expenses', 'expense', 'expenses', { isGroup: true });
  await add('dirTravel', '5910', 'Director Travel', 'expense', 'dirExp');
  await add('dirEnt', '5920', 'Director Entertainment', 'expense', 'dirExp');
  const sys = ['cash', 'advances', 'receivable', 'payable', 'inventory', 'cogs', 'laborIncome', 'partsIncome', 'salesTax', 'salesReturns', 'salaryExpense', 'salaryPayable', 'deductionsPayable', 'directorCapital'];
  await prisma.setting.create({ data: { companyId: c, key: 'finance.accounts', value: Object.fromEntries(sys.map((k) => [k, acc[k]])) } });

  // ─── Master data ───
  const md = async (type: string, rows: [string, string, Prisma.InputJsonValue?][]) => {
    const ids: string[] = [];
    for (const [i, [code, name, value]] of rows.entries()) ids.push((await prisma.masterData.create({ data: { companyId: c, type, code, name, value: value ?? Prisma.JsonNull, sort: i } })).id);
    return ids;
  };
  await md('employee_type', [['permanent', 'Permanent'], ['probation', 'Probation'], ['contract', 'Contract'], ['intern', 'Intern'], ['consultant', 'Consultant'], ['director', 'Director', { director: true }]]);
  await md('unit', [['PCS', 'Pieces'], ['BOX', 'Box'], ['LTR', 'Litre'], ['KG', 'Kilogram'], ['HR', 'Hour']]);
  await md('tax', [['GST18', 'GST 18%', { rate: 18 }], ['NIL', 'Exempt', { rate: 0 }]]);
  await md('currency', [['PKR', 'Pakistani Rupee', { symbol: 'Rs' }], ['USD', 'US Dollar', { symbol: '$' }]]);
  await md('payment_method', [['CASH', 'Cash'], ['BANK', 'Bank Transfer'], ['CARD', 'Card'], ['CHEQUE', 'Cheque'], ['WALLET', 'Mobile Wallet']]);
  const [fuelHead] = await md('expense_head', [
    ['FUEL', 'Fuel', { accountId: acc.fuel }], ['TRAVEL', 'Travel', { accountId: acc.travel }], ['UTIL', 'Utilities', { accountId: acc.utilities }],
    ['REPAIR', 'Repairs', { accountId: acc.repairsExp }], ['OFFICE', 'Office Supplies', { accountId: acc.office }],
    ['DIR-TRAVEL', 'Director Travel', { accountId: acc.dirTravel, director: true }], ['DIR-ENT', 'Director Entertainment', { accountId: acc.dirEnt, director: true }],
  ]);
  await prisma.setting.create({ data: { companyId: c, key: 'fleet.fuelHeadId', value: fuelHead } });
  await md('service_rate', [['INSPECT', 'Inspection fee (returned unrepaired)', { rate: 1500 }]]);
  await md('reason', [['REJ-BUDGET', 'Over budget', { kind: 'rejection' }], ['RET-DEFECT', 'Defective', { kind: 'return' }], ['REF-UNREPAIRED', 'Could not repair', { kind: 'refund' }], ['REF-QUALITY', 'Quality complaint', { kind: 'refund' }]]);
  await md('holiday', [['KASHMIR', 'Kashmir Day', { date: '2026-02-05' }], ['PAKDAY', 'Pakistan Day', { date: '2026-03-23' }], ['LABOUR', 'Labour Day', { date: '2026-05-01' }], ['INDEP', 'Independence Day', { date: '2026-08-14' }], ['QUAID', 'Quaid Day', { date: '2026-12-25' }]]);
  for (const d of ['Management', 'Human Resources', 'Finance', 'Service Center', 'Stores', 'Transport']) await prisma.department.create({ data: { companyId: c, branchId: branch.id, name: d } });
  for (const d of ['Director', 'Manager', 'Accountant', 'Technician', 'Front Desk Officer', 'Store Keeper', 'Driver', 'Security Guard']) await prisma.designation.create({ data: { companyId: c, name: d } });
  await prisma.shift.create({ data: { companyId: c, name: 'General (9–5)', start: '09:00', end: '17:00' } });
  await prisma.leaveType.createMany({ data: [{ companyId: c, name: 'Annual', daysPerYear: 14, carryForward: 7, encashable: true }, { companyId: c, name: 'Casual', daysPerYear: 10 }, { companyId: c, name: 'Sick', daysPerYear: 8 }, { companyId: c, name: 'Unpaid', daysPerYear: 365, paid: false }] });
  await prisma.warehouse.createMany({ data: [{ companyId: c, branchId: branch.id, code: 'MAIN', name: 'Main Store' }, { companyId: c, code: 'DEMO', name: 'Demo (with clients)', kind: 'demo' }, { companyId: c, code: 'SCRAP', name: 'Scrap', kind: 'scrap' }, { companyId: c, branchId: branch.id, code: 'WORKSHOP', name: 'Workshop store', kind: 'repair' }] });

  // ─── Default workflows (edit in Admin › Workflows) ───
  const wf = (resource: string, name: string, steps: object[], conditions: object | null = null, priority = 0) =>
    prisma.workflowDefinition.create({ data: { companyId: c, resource, name, steps: steps as Prisma.InputJsonValue, conditions: conditions ?? Prisma.JsonNull, priority } });
  await wf('finance.advance', 'Large advance', [{ name: 'Manager', approverType: 'manager' }, { name: 'Director', approverType: 'role', approverId: roleIds.Director }], { minAmount: 50000 }, 10);
  await wf('finance.advance', 'Advance', [{ name: 'Accounts', approverType: 'role', approverId: roleIds.Accountant }]);
  await wf('finance.claim', 'Expense claim', [{ name: 'Manager', approverType: 'manager' }, { name: 'Accounts check', approverType: 'role', approverId: roleIds.Accountant }]);
  await wf('hrm.leave', 'Leave', [{ name: 'Manager', approverType: 'manager' }]);
  await wf('hrm.correction', 'Attendance correction', [{ name: 'HR', approverType: 'role', approverId: roleIds['HR Manager'] }]);
  await wf('hrm.payroll', 'Payroll release', [{ name: 'Accounts', approverType: 'role', approverId: roleIds.Accountant }, { name: 'Director', approverType: 'role', approverId: roleIds.Director }]);
  await wf('purchase.order', 'Purchase order', [{ name: 'Director', approverType: 'role', approverId: roleIds.Director }], { minAmount: 100000 });
  await wf('repair.quotation', 'Quotation discount', [{ name: 'Repair Manager', approverType: 'role', approverId: roleIds['Repair Manager'] }]);
  await wf('repair.creditnote', 'Refund', [{ name: 'Repair Manager', approverType: 'role', approverId: roleIds['Repair Manager'] }, { name: 'Accounts', approverType: 'role', approverId: roleIds.Accountant }]);
  await wf('gatepass.pass', 'Gatepass', [{ name: 'Store / Manager', approverType: 'role', approverId: roleIds['Store Keeper'] }]);
  await wf('inventory.adjustment', 'Stock adjustment', [{ name: 'Admin', approverType: 'role', approverId: roleIds.Admin }]);

  // ─── Prebuilt report pack (editable) ───
  const range = { gte: '$from', lte: '$to' };
  const reports: [string, object][] = [
    ['Monthly attendance summary', { resource: 'hrm.attendance', filters: { date: range }, groupBy: ['employeeId', 'status'], aggregates: [{ field: 'lateMin', fn: 'sum' }, { field: 'overtimeMin', fn: 'sum' }] }],
    ['Late comers', { resource: 'hrm.attendance', filters: { date: range, status: 'late' }, groupBy: ['employeeId'], aggregates: [{ field: 'lateMin', fn: 'sum' }], sort: { field: 'sum_lateMin', dir: 'desc' } }],
    ['Payroll register', { resource: 'hrm.payslip', filters: { period: '$period' }, columns: ['employeeId', 'gross', 'deductions', 'advanceDeduction', 'net', 'paid', 'status'] }],
    ['Expenses by category', { resource: 'finance.claim', filters: { date: range, status: { in: ['paid', 'settled'] } }, groupBy: ['departmentId'], aggregates: [{ field: 'total', fn: 'sum' }], chart: { type: 'bar', x: 'departmentId', y: 'sum_total' } }],
    ['Advances outstanding', { resource: 'finance.advance', filters: { status: 'disbursed' }, columns: ['number', 'employeeId', 'amount', 'recovered'], calc: [{ name: 'outstanding', a: 'amount', op: '-', b: 'recovered' }] }],
    ['Loans outstanding', { resource: 'finance.loan', filters: { status: 'disbursed' }, columns: ['number', 'employeeId', 'amount', 'installmentAmount', 'recovered'], calc: [{ name: 'outstanding', a: 'amount', op: '-', b: 'recovered' }] }],
    ['Jobs by status', { resource: 'repair.job', groupBy: ['status'], chart: { type: 'pie', x: 'status', y: 'count' } }],
    ['Technician workload', { resource: 'repair.job', filters: { status: { in: ['assigned', 'diagnosing', 'diagnosed', 'approved', 'parts_pending', 'in_repair', 'qc'] } }, groupBy: ['technicianId'], chart: { type: 'bar', x: 'technicianId', y: 'count' } }],
    ['Sales by customer', { resource: 'repair.invoice', filters: { date: range }, groupBy: ['customerId'], aggregates: [{ field: 'total', fn: 'sum' }, { field: 'paid', fn: 'sum' }], calc: [{ name: 'balance', a: 'sum_total', op: '-', b: 'sum_paid' }] }],
    ['Stock movement', { resource: 'inventory.movement', filters: { at: range }, groupBy: ['productId', 'type'], aggregates: [{ field: 'qty', fn: 'sum' }] }],
    ['Purchases by vendor', { resource: 'purchase.order', filters: { date: range }, groupBy: ['vendorId'], aggregates: [{ field: 'total', fn: 'sum' }] }],
    ['Vendor payables', { resource: 'purchase.bill', filters: { status: { in: ['open', 'partially_paid'] } }, groupBy: ['vendorId'], aggregates: [{ field: 'amount', fn: 'sum' }, { field: 'paid', fn: 'sum' }], calc: [{ name: 'due', a: 'sum_amount', op: '-', b: 'sum_paid' }] }],
    ['Fleet fuel cost', { resource: 'fleet.fuel', filters: { date: range }, groupBy: ['vehicleId'], aggregates: [{ field: 'liters', fn: 'sum' }, { field: 'cost', fn: 'sum' }], chart: { type: 'bar', x: 'vehicleId', y: 'sum_cost' } }],
    ['Demo items outstanding', { resource: 'gatepass.pass', filters: { type: 'demo_out', status: { in: ['out', 'partially_returned'] } }, columns: ['number', 'partyName', 'expectedReturn', 'status'] }],
  ];
  const manage = [roleIds.Admin, roleIds.Director, roleIds.Accountant];
  for (const [name, definition] of reports) await prisma.savedReport.create({ data: { companyId: c, name, definition: definition as Prisma.InputJsonValue, sharedRoles: manage, createdById: admin.id } });

  console.log(`Seeded ${ACTIONS.length} actions × ${perms.length / ACTIONS.length} resources. Login: ${email}`);
}

main().finally(() => prisma.$disconnect());
