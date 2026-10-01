/**
 * Standard report library: ready-made reports per module, run by the same safe engine as the report builder
 * (data scope, field restrictions, exports). Each takes the same parameters: a date range on `dateField`
 * (when set) and an optional branch.
 */
export interface StandardReport {
  key: string;
  module: string;
  name: string;
  description: string;
  resource: string;
  /** Field the From/To range applies to; omit for "as of now" reports (stock, open items). */
  dateField?: string;
  columns?: string[];
  groupBy?: string[];
  aggregates?: { field: string; fn: 'sum' | 'avg' | 'min' | 'max' | 'count' }[];
  calc?: { name: string; a: string | number; op: '+' | '-' | '*' | '/'; b: string | number }[];
  filters?: Record<string, unknown>;
  sort?: { field: string; dir: 'asc' | 'desc' };
  chart?: 'bar' | 'pie' | 'table';
}

const sum = (field: string) => ({ field, fn: 'sum' as const });

export const STANDARD_REPORTS: StandardReport[] = [
  // ─── Finance ───
  { key: 'fin-claims-by-employee', module: 'finance', name: 'Expense claims by employee', description: 'Total claimed and reimbursed per employee in the period.', resource: 'finance.claim', dateField: 'date', groupBy: ['employeeId'], aggregates: [sum('total'), sum('reimbursed')], sort: { field: 'sum_total', dir: 'desc' }, chart: 'bar' },
  { key: 'fin-claims-by-status', module: 'finance', name: 'Expense claims by status', description: 'How many claims are draft, pending, approved, paid…', resource: 'finance.claim', dateField: 'date', groupBy: ['status'], aggregates: [sum('total')], chart: 'pie' },
  { key: 'fin-advances-open', module: 'finance', name: 'Outstanding expense advances', description: 'Disbursed advances still to be settled, with the balance per advance.', resource: 'finance.advance', columns: ['number', 'employeeId', 'purpose', 'amount', 'recovered', 'disbursedAt'], filters: { status: 'disbursed' }, calc: [{ name: 'outstanding', a: 'amount', op: '-', b: 'recovered' }], sort: { field: 'disbursedAt', dir: 'asc' } },
  { key: 'fin-loans-open', module: 'finance', name: 'Salary advances & loans outstanding', description: 'Loans being recovered through payroll, with balances.', resource: 'finance.loan', columns: ['number', 'employeeId', 'amount', 'installments', 'installmentAmount', 'recovered'], filters: { status: 'disbursed' }, calc: [{ name: 'outstanding', a: 'amount', op: '-', b: 'recovered' }] },
  { key: 'fin-payments-by-account', module: 'finance', name: 'Cash & bank movements', description: 'Money in and out per cash/bank account in the period.', resource: 'finance.payment', dateField: 'date', groupBy: ['accountId', 'direction'], aggregates: [sum('amount')], chart: 'bar' },
  { key: 'fin-vouchers-by-purpose', module: 'finance', name: 'Payment vouchers by purpose', description: 'Advance disbursements, reimbursements and loans paid out.', resource: 'finance.voucher', dateField: 'createdAt', groupBy: ['purpose', 'status'], aggregates: [sum('amount')], chart: 'bar' },
  // ─── P & R ───
  { key: 'pr-open-dues', module: 'payables', name: 'Open payables & receivables', description: 'Every open due with its balance, oldest first.', resource: 'payables.due', columns: ['number', 'direction', 'partyName', 'description', 'dueDate', 'amount', 'paid'], filters: { status: { in: ['open', 'partially_paid'] } }, calc: [{ name: 'balance', a: 'amount', op: '-', b: 'paid' }], sort: { field: 'dueDate', dir: 'asc' } },
  { key: 'pr-dues-by-direction', module: 'payables', name: 'Dues raised in the period', description: 'Payables vs receivables raised, and how much is settled.', resource: 'payables.due', dateField: 'dueDate', groupBy: ['direction', 'status'], aggregates: [sum('amount'), sum('paid')], chart: 'bar' },
  // ─── HR ───
  { key: 'hr-headcount-dept', module: 'hrm', name: 'Headcount by department', description: 'Active employees per department.', resource: 'hrm.employee', groupBy: ['departmentId'], filters: { status: { in: ['active', 'on_leave'] } }, sort: { field: 'count', dir: 'desc' }, chart: 'bar' },
  { key: 'hr-headcount-type', module: 'hrm', name: 'Headcount by employee type', description: 'Permanent, contract, intern, director…', resource: 'hrm.employee', groupBy: ['type'], filters: { status: { in: ['active', 'on_leave'] } }, chart: 'pie' },
  { key: 'hr-joiners', module: 'hrm', name: 'New joiners', description: 'Employees who joined in the period.', resource: 'hrm.employee', dateField: 'joinDate', columns: ['code', 'name', 'departmentId', 'designationId', 'branchId', 'type', 'joinDate'], sort: { field: 'joinDate', dir: 'asc' } },
  { key: 'hr-attendance-status', module: 'hrm', name: 'Attendance summary', description: 'Present, late, absent, leave days in the period.', resource: 'hrm.attendance', dateField: 'date', groupBy: ['status'], chart: 'pie' },
  { key: 'hr-late-by-employee', module: 'hrm', name: 'Late arrivals by employee', description: 'Late days and total late minutes per employee.', resource: 'hrm.attendance', dateField: 'date', filters: { status: 'late' }, groupBy: ['employeeId'], aggregates: [sum('lateMin')], sort: { field: 'count', dir: 'desc' }, chart: 'bar' },
  { key: 'hr-overtime', module: 'hrm', name: 'Overtime by employee', description: 'Overtime minutes worked in the period.', resource: 'hrm.attendance', dateField: 'date', groupBy: ['employeeId'], aggregates: [sum('overtimeMin'), sum('workedMin')], sort: { field: 'sum_overtimeMin', dir: 'desc' }, chart: 'bar' },
  { key: 'hr-leave-by-employee', module: 'hrm', name: 'Leave taken by employee', description: 'Approved leave days per employee.', resource: 'hrm.leave', dateField: 'from', filters: { status: 'approved' }, groupBy: ['employeeId'], aggregates: [sum('days')], sort: { field: 'sum_days', dir: 'desc' }, chart: 'bar' },
  { key: 'hr-leave-by-type', module: 'hrm', name: 'Leave by type', description: 'Approved leave days per leave type.', resource: 'hrm.leave', dateField: 'from', filters: { status: 'approved' }, groupBy: ['leaveTypeId'], aggregates: [sum('days')], chart: 'pie' },
  { key: 'hr-payroll-by-period', module: 'hrm', name: 'Payroll cost by month', description: 'Gross, deductions and net pay per payroll period.', resource: 'hrm.payslip', dateField: 'createdAt', groupBy: ['period'], aggregates: [sum('gross'), sum('deductions'), sum('net'), sum('paid')], chart: 'bar' },
  // ─── Repair ───
  { key: 'rep-jobs-by-status', module: 'repair', name: 'Repair jobs by status', description: 'Jobs received in the period, by current status.', resource: 'repair.job', dateField: 'createdAt', groupBy: ['status'], chart: 'bar' },
  { key: 'rep-jobs-by-technician', module: 'repair', name: 'Jobs by technician', description: 'Workload per technician for jobs received in the period.', resource: 'repair.job', dateField: 'createdAt', groupBy: ['technicianId', 'status'], chart: 'bar' },
  { key: 'rep-jobs-by-type', module: 'repair', name: 'Jobs by equipment type', description: 'Radios, cameras, gateways… received in the period.', resource: 'repair.job', dateField: 'createdAt', groupBy: ['productType'], sort: { field: 'count', dir: 'desc' }, chart: 'pie' },
  { key: 'rep-sales-by-customer', module: 'repair', name: 'Invoiced by customer', description: 'Invoiced, paid and balance per customer.', resource: 'repair.invoice', dateField: 'date', groupBy: ['customerId'], aggregates: [sum('total'), sum('paid'), sum('credited')], calc: [{ name: 'balance', a: 'sum_total', op: '-', b: 'sum_paid' }], sort: { field: 'sum_total', dir: 'desc' }, chart: 'bar' },
  { key: 'rep-unpaid-invoices', module: 'repair', name: 'Unpaid invoices', description: 'Open customer invoices with balance.', resource: 'repair.invoice', columns: ['number', 'customerId', 'date', 'total', 'paid', 'credited'], filters: { status: { in: ['unpaid', 'partially_paid'] } }, calc: [{ name: 'balance', a: 'total', op: '-', b: 'paid' }], sort: { field: 'date', dir: 'asc' } },
  // ─── Inventory & Purchase ───
  { key: 'inv-stock', module: 'inventory', name: 'Stock on hand', description: 'Quantity per product and warehouse, right now.', resource: 'inventory.stock', columns: ['productId', 'warehouseId', 'qty'], sort: { field: 'qty', dir: 'desc' } },
  { key: 'inv-movements', module: 'inventory', name: 'Stock movements by type', description: 'Receipts, issues, transfers, sales… and their quantities.', resource: 'inventory.movement', dateField: 'at', groupBy: ['type'], aggregates: [sum('qty')], chart: 'bar' },
  { key: 'pur-po-by-vendor', module: 'purchase', name: 'Purchases by vendor', description: 'Purchase order value per vendor in the period.', resource: 'purchase.order', dateField: 'date', groupBy: ['vendorId'], aggregates: [sum('total')], sort: { field: 'sum_total', dir: 'desc' }, chart: 'bar' },
  { key: 'pur-open-bills', module: 'purchase', name: 'Open vendor bills', description: 'Unpaid vendor bills with balance and due date.', resource: 'purchase.bill', columns: ['number', 'vendorId', 'vendorRef', 'date', 'dueDate', 'amount', 'paid'], filters: { status: { in: ['open', 'partially_paid'] } }, calc: [{ name: 'balance', a: 'amount', op: '-', b: 'paid' }], sort: { field: 'dueDate', dir: 'asc' } },
  // ─── Fleet ───
  { key: 'fleet-fuel-by-vehicle', module: 'fleet', name: 'Fuel by vehicle', description: 'Litres and fuel cost per vehicle.', resource: 'fleet.fuel', dateField: 'date', groupBy: ['vehicleId'], aggregates: [sum('liters'), sum('cost')], calc: [{ name: 'cost_per_litre', a: 'sum_cost', op: '/', b: 'sum_liters' }], sort: { field: 'sum_cost', dir: 'desc' }, chart: 'bar' },
  { key: 'fleet-maintenance', module: 'fleet', name: 'Maintenance jobs by vehicle', description: 'Maintenance jobs opened per vehicle.', resource: 'fleet.maintenance', dateField: 'createdAt', groupBy: ['vehicleId', 'status'], chart: 'bar' },
  // ─── Gatepass ───
  { key: 'gp-by-type', module: 'gatepass', name: 'Gate passes by type & status', description: 'Outward, returnable, transfer… and where they stand.', resource: 'gatepass.pass', dateField: 'createdAt', groupBy: ['type', 'status'], chart: 'bar' },
  // ─── Utilities ───
  { key: 'ut-bills-by-connection', module: 'utilities', name: 'Utility cost by connection', description: 'Bills, units and amounts per connection in the period.', resource: 'utilities.bill', dateField: 'billDate', groupBy: ['connectionId'], aggregates: [sum('units'), sum('total'), sum('paid')], sort: { field: 'sum_total', dir: 'desc' }, chart: 'bar' },
  { key: 'ut-bills-by-site', module: 'utilities', name: 'Utility cost by site', description: 'Total utility spend per site.', resource: 'utilities.bill', dateField: 'billDate', groupBy: ['siteId'], aggregates: [sum('total')], sort: { field: 'sum_total', dir: 'desc' }, chart: 'pie' },
  { key: 'ut-unpaid', module: 'utilities', name: 'Unpaid utility bills', description: 'Open bills with due dates, oldest first.', resource: 'utilities.bill', columns: ['number', 'connectionId', 'siteId', 'billDate', 'dueDate', 'total', 'paid', 'status'], filters: { status: { in: ['unpaid', 'partially_paid', 'disputed'] } }, calc: [{ name: 'balance', a: 'total', op: '-', b: 'paid' }], sort: { field: 'dueDate', dir: 'asc' } },
  // ─── Serial tracking ───
  { key: 'ser-by-status', module: 'serials', name: 'Serials by status', description: 'In stock, issued, on demo, sold, RMA…', resource: 'serials.item', groupBy: ['status'], chart: 'pie' },
];
