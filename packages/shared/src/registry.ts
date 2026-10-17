/**
 * Resource registry: the one place a module declares its screens.
 * Field types, required-ness and validation come from the Prisma schema (served by GET /api/meta);
 * this file only adds what the schema can't say: titles, list columns, refs, numbering, workflow, actions.
 */
export interface ActionField {
  type: 'string' | 'text' | 'number' | 'money' | 'date' | 'bool' | 'enum' | 'ref' | 'json' | 'lines';
  label?: string;
  /** type 'lines': the columns of each row. `hidden` columns are sent but not shown; `readonly` ones are display only. */
  columns?: Record<string, ActionField & { hidden?: boolean; readonly?: boolean; label?: string }>;
  /** type 'lines': start with rows built from a child list of the record, e.g. PO lines still to receive. */
  prefill?: { rel: string; map: Record<string, string>; keepIf?: string };
  ref?: string;
  /** List filters for the ref picker, e.g. { isGroup: false }. */
  filters?: Record<string, unknown>;
  /** Prefill from a record field (e.g. 'amount'); `a-b` subtracts two fields (e.g. 'total-paid'). */
  from?: string;
  options?: string[];
  required?: boolean;
}

/** Repayment of an advance/loan: next installment (auto-detected), a custom amount, or the full balance. */
const REPAY_FIELDS: Record<string, ActionField> = {
  mode: { type: 'enum', options: ['next_installment', 'custom_amount', 'full_settlement'], required: true, label: 'Repay' },
  amount: { type: 'money', label: 'Amount (custom amount only)' },
  accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] }, label: 'Received into' },
};

export interface ActionDef {
  name: string;
  label: string;
  /** API path; `:id` is replaced with the record id. */
  path: string;
  fields?: Record<string, ActionField>;
  /** Only shown when record.status is one of these. */
  when?: string[];
  /** Defaults to `<resource>.update`. */
  permission?: string;
  /** Opens returned `url`/html in a new tab instead of refreshing. */
  opens?: boolean;
}

export interface ResourceDef {
  key: string; // module.resource  (also permission prefix)
  model: string; // Prisma model name
  label: string;
  title: string;
  subtitle?: string;
  list: string[];
  search?: string[];
  barcode?: string;
  /** fk field -> resource key; engine validates same-company and resolves titles. */
  refs?: Record<string, string>;
  number?: { field: string; docType: string; pattern: string };
  /** Submit-for-approval via the workflow engine. Model must have `status`. */
  workflow?: boolean;
  amountField?: string;
  /** Field matched for `own` data scope. */
  owner?: 'createdById' | 'employeeId' | 'id' | 'userId' | 'assigneeId' | 'technicianId' | 'driverId';
  /** Server-managed; never accepted from clients. */
  readonly?: string[];
  hidden?: string[];
  /** Visible only with `<key>.manage`. */
  restricted?: string[];
  /** Nested line relations editable with the parent: relation field -> child model. */
  children?: Record<string, string>;
  /** Fixed row filter + create default, so one table can back several screens (e.g. Job kind=repair vs fleet). */
  scope?: Record<string, string | number | boolean>;
  /**
   * When a field is picked, copy values from the picked record: { productId: { price: 'cost', taxRate: 'taxId>value.rate' } }.
   * Source expressions: a field, `a-b` (difference), or `ref>path` (follow a reference, then a dotted path).
   */
  autofill?: Record<string, Record<string, string>>;
  /** Same as autofill, for rows of child lines: { lines: { productId: { price: 'cost' } } }. */
  lineAutofill?: Record<string, Record<string, Record<string, string>>>;
  /** JSON array columns edited as a line table instead of raw JSON. */
  lineColumns?: Record<string, Record<string, ActionField & { hidden?: boolean; readonly?: boolean; label?: string }>>;
  /** Live-computed fields: { days: 'days(from,to)' }. */
  compute?: Record<string, string>;
  /** Fixed choices for plain string columns (rendered as dropdowns, validated server-side). */
  enums?: Record<string, string[]>;
  /** Actions on the rows selected in the list (opened/downloaded with ?ids=a,b,c). */
  bulk?: { label: string; path: string; permission?: string }[];
  /** Read-only lists of other records that point at this one, shown on the record page. */
  related?: { resource: string; field: string; label: string; columns: string[] }[];
  /** Kanban columns (status field). */
  statuses?: string[];
  ops?: ('create' | 'update' | 'delete')[];
  /** Long-text fields edited with the rich-text editor (stored as sanitised HTML). */
  rich?: string[];
  /** Fields whose choices are a company-managed Master Data list: { type: 'employee_type' } (value = the entry's code). */
  lists?: Record<string, string>;
  /** A dedicated screen for creating records (e.g. the guided claim form) instead of the generic form. */
  createPath?: string;
  /** Record can be edited/deleted only while status is one of these. */
  editableWhen?: string[];
  actions?: ActionDef[];
  printable?: boolean;
  /** Stopwatch time logs on the record. */
  timeTracking?: boolean;
  /** Date field used by the calendar view. */
  calendar?: string;
  /** Menu group; defaults to module. */
  group?: string;
}

const WF = ['status'];
const EDIT_DRAFT = ['draft', 'returned'];

export const MODULES: Record<string, { label: string; icon: string }> = {
  core: { label: 'Admin', icon: 'settings' },
  hrm: { label: 'HR', icon: 'users' },
  finance: { label: 'Finance', icon: 'wallet' },
  inventory: { label: 'Inventory', icon: 'package' },
  purchase: { label: 'Purchase', icon: 'cart' },
  repair: { label: 'Repair', icon: 'wrench' },
  fleet: { label: 'Fleet', icon: 'truck' },
  gatepass: { label: 'Gatepass', icon: 'door' },
  sales: { label: 'Sales', icon: 'store' },
  payables: { label: 'P & R', icon: 'scale' },
  serials: { label: 'Serial Tracking', icon: 'scan' },
  utilities: { label: 'Utilities', icon: 'bolt' },
  catalog: { label: 'Catalog', icon: 'book' },
  reports: { label: 'Reports', icon: 'chart' },
};

export const RESOURCES: ResourceDef[] = [
  // ─── Core ──────────────────────────────────────────────────
  { key: 'core.company', model: 'Company', label: 'Company', title: 'name', list: ['name', 'taxId', 'phone', 'currency', 'timezone'], ops: ['update'] },
  { key: 'core.branch', model: 'Branch', label: 'Branches', title: 'name', subtitle: 'code', list: ['code', 'name', 'phone'], search: ['code', 'name'] },
  { key: 'core.department', model: 'Department', label: 'Departments', title: 'name', list: ['name', 'branchId', 'headId'], refs: { branchId: 'core.branch', headId: 'hrm.employee' }, search: ['name'] },
  { key: 'core.designation', model: 'Designation', label: 'Designations', title: 'name', list: ['name'] },
  { key: 'core.costcenter', model: 'CostCenter', label: 'Cost Centers', title: 'name', list: ['code', 'name'] },
  {
    key: 'core.user', model: 'User', label: 'Users', title: 'name', subtitle: 'email', list: ['name', 'email', 'username', 'isActive', 'lastLoginAt'],
    search: ['name', 'email', 'username'], refs: { branchId: 'core.branch', departmentId: 'core.department' }, owner: 'id',
    hidden: ['passwordHash', 'totpSecret', 'resetTokenHash', 'resetExpires', 'failedLogins', 'lockedUntil'], readonly: ['lastLoginAt', 'totpEnabled'],
    actions: [
      { name: 'password', label: 'Set password', path: 'users/:id/password', fields: { password: { type: 'string', required: true } }, permission: 'core.user.manage' },
      { name: 'logout', label: 'Force logout', path: 'auth/users/:id/logout', permission: 'core.user.manage' },
    ],
  },
  { key: 'core.role', model: 'Role', label: 'Roles', title: 'name', list: ['name', 'isSystem'], readonly: ['isSystem'] },
  { key: 'core.masterdata', model: 'MasterData', label: 'Master Data', title: 'name', subtitle: 'type', list: ['type', 'code', 'name', 'isActive', 'sort'], search: ['type', 'code', 'name'] },
  { key: 'core.sequence', model: 'Sequence', label: 'Numbering', title: 'docType', list: ['docType', 'pattern', 'reset', 'current', 'branchId'], readonly: ['period'] },
  { key: 'core.customfield', model: 'CustomField', label: 'Custom Fields', title: 'label', list: ['resource', 'name', 'label', 'type', 'required'] },
  { key: 'core.template', model: 'Template', label: 'Templates', title: 'key', list: ['kind', 'key', 'subject'] },
  { key: 'core.workflow', model: 'WorkflowDefinition', label: 'Workflows', title: 'name', list: ['name', 'resource', 'priority', 'isActive'] },
  { key: 'core.setting', model: 'Setting', label: 'Settings', title: 'key', list: ['key', 'value'], search: ['key'] },
  { key: 'core.audit', model: 'AuditLog', label: 'Audit Log', title: 'action', subtitle: 'entityType', list: ['createdAt', 'userId', 'action', 'entityType', 'entityId', 'ip'], refs: { userId: 'core.user' }, ops: [], search: ['action', 'entityType', 'entityId'] },

  // ─── HRM ───────────────────────────────────────────────────
  {
    autofill: { departmentId: { managerId: 'headId', branchId: 'branchId' } },
    key: 'hrm.employee', model: 'Employee', label: 'Employees', title: 'name', subtitle: 'code',
    list: ['code', 'name', 'departmentId', 'designationId', 'branchId', 'phone', 'status'], search: ['code', 'name', 'cnic', 'phone', 'email'], barcode: 'code',
    refs: { branchId: 'core.branch', departmentId: 'core.department', designationId: 'core.designation', managerId: 'hrm.employee', userId: 'core.user', shiftId: 'hrm.shift', accountId: 'finance.account' },
    number: { field: 'code', docType: 'EMP', pattern: 'EMP-{SEQ:4}' }, owner: 'userId', readonly: ['accountId', 'qrToken', 'isDirector', 'status'], restricted: ['bank', 'cnic'], lists: { type: 'employee_type' },
    statuses: ['active', 'on_leave', 'resigned', 'terminated'], printable: true,
    actions: [
      { name: 'create-user', label: 'Create user account', path: 'hrm/employees/:id/create-user', fields: { email: { type: 'string', required: true }, password: { type: 'string', required: true } }, permission: 'core.user.create' },
      { name: 'id-card', label: 'Print ID card', path: 'print/hrm.employee/:id?template=idcard', opens: true, permission: 'hrm.employee.print' },
      { name: 'statement', label: 'Ledger', path: 'finance/statement/employee/:id', opens: true, permission: 'finance.statement.view' },
    ],
  },
  { key: 'hrm.document', model: 'DocumentRecord', label: 'Documents', title: 'type', subtitle: 'number', list: ['entityType', 'entityId', 'type', 'number', 'expiryDate'] },
  { key: 'hrm.event', model: 'EmployeeEvent', label: 'Lifecycle Events', title: 'type', list: ['employeeId', 'type', 'date', 'status'], refs: { employeeId: 'hrm.employee' }, workflow: true, readonly: WF, editableWhen: EDIT_DRAFT },
  { key: 'hrm.shift', model: 'Shift', label: 'Shifts', title: 'name', list: ['name', 'start', 'end', 'graceMin'] },
  {
    key: 'hrm.station', model: 'KioskStation', label: 'Kiosk Stations', title: 'name', list: ['name', 'branchId', 'location', 'lastSeenAt', 'isActive'],
    refs: { branchId: 'core.branch' }, hidden: ['pairingHash', 'deviceTokenHash', 'secret'], readonly: ['lastSeenAt', 'pairingExpires'],
    actions: [{ name: 'pair', label: 'Pair a device (link / QR)', path: 'hrm/kiosk/stations/:id/pairing-code', permission: 'hrm.station.manage' }],
  },
  { key: 'hrm.punch', model: 'AttendancePunch', label: 'Punches', title: 'method', list: ['employeeId', 'at', 'method', 'stationId'], refs: { employeeId: 'hrm.employee', stationId: 'hrm.station' }, ops: [], owner: 'employeeId' },
  {
    key: 'hrm.attendance', model: 'AttendanceDay', label: 'Attendance', title: 'status', calendar: 'date', list: ['date', 'employeeId', 'status', 'inAt', 'outAt', 'lateMin', 'overtimeMin'],
    refs: { employeeId: 'hrm.employee' }, ops: [], owner: 'employeeId', statuses: ['present', 'late', 'half_day', 'absent', 'leave', 'holiday', 'weekend'],
  },
  { key: 'hrm.correction', model: 'AttendanceCorrection', label: 'Attendance Corrections', title: 'reason', list: ['employeeId', 'date', 'inAt', 'outAt', 'status'], refs: { employeeId: 'hrm.employee' }, workflow: true, owner: 'employeeId', readonly: WF, editableWhen: EDIT_DRAFT },
  { key: 'hrm.leavetype', model: 'LeaveType', label: 'Leave Types', title: 'name', list: ['name', 'daysPerYear', 'paid', 'carryForward'] },
  {
    compute: { days: 'days(from,to)' },
    key: 'hrm.leave', model: 'LeaveRequest', label: 'Leave Requests', title: 'reason', list: ['employeeId', 'leaveTypeId', 'from', 'to', 'days', 'status'],
    refs: { employeeId: 'hrm.employee', leaveTypeId: 'hrm.leavetype' }, workflow: true, owner: 'employeeId', readonly: WF, editableWhen: EDIT_DRAFT, amountField: 'days', calendar: 'from',
  },
  {
    key: 'hrm.task', model: 'Task', label: 'Tasks', title: 'title', subtitle: 'number', list: ['number', 'title', 'assigneeId', 'priority', 'dueDate', 'status'], search: ['number', 'title', 'project'],
    refs: { assigneeId: 'hrm.employee' }, number: { field: 'number', docType: 'TSK', pattern: 'TSK-{YY}{MM}-{SEQ:4}' }, owner: 'assigneeId',
    statuses: ['todo', 'in_progress', 'review', 'done', 'blocked'], timeTracking: true, calendar: 'dueDate',
  },
  { key: 'hrm.dailyreport', model: 'DailyReport', label: 'Daily Reports', title: 'summary', list: ['date', 'employeeId', 'summary', 'reviewedById'], refs: { employeeId: 'hrm.employee', reviewedById: 'core.user' }, owner: 'employeeId' },
  {
    lineColumns: { components: { name: { type: 'string', required: true, label: 'Component' }, kind: { type: 'enum', options: ['allowance', 'deduction'], required: true, label: 'Type' }, mode: { type: 'enum', options: ['fixed', 'percent'], required: true, label: 'Fixed / % of basic' }, value: { type: 'number', required: true, label: 'Amount or %' } } },
    key: 'hrm.salary', model: 'SalaryStructure', label: 'Salary Structures', title: 'employeeId', list: ['employeeId', 'basic', 'taxPercent'], refs: { employeeId: 'hrm.employee' }, restricted: ['basic', 'components'], owner: 'employeeId',
  },
  {
    key: 'hrm.payroll', model: 'PayrollRun', label: 'Payroll Runs', title: 'period', subtitle: 'number', list: ['number', 'period', 'branchId', 'gross', 'net', 'status'],
    refs: { branchId: 'core.branch' }, number: { field: 'number', docType: 'PAY', pattern: 'PAY-{YYYY}-{SEQ:4}' }, workflow: true, amountField: 'net',
    readonly: ['status', 'gross', 'net', 'journalId'], ops: ['delete'], editableWhen: EDIT_DRAFT,
    actions: [
      { name: 'post', label: 'Post to ledger', path: 'hrm/payroll/:id/post', when: ['approved'], permission: 'hrm.payroll.approve' },
      { name: 'bank-sheet', label: 'Bank transfer sheet', path: 'hrm/payroll/:id/bank-sheet', opens: true, permission: 'hrm.payroll.export' },
    ],
  },
  {
    key: 'hrm.payslip', model: 'Payslip', label: 'Payslips', title: 'period', list: ['period', 'employeeId', 'gross', 'deductions', 'net', 'paid', 'status'],
    refs: { employeeId: 'hrm.employee', runId: 'hrm.payroll' }, ops: [], owner: 'employeeId', printable: true,
    actions: [{ name: 'pay', label: 'Pay salary', path: 'hrm/payslips/:id/pay', when: ['posted', 'partially_paid'], fields: { amount: { type: 'money', required: true, from: 'net-paid' }, accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] } }, methodId: { type: 'ref', ref: 'core.masterdata' } }, permission: 'finance.payment.create' }],
  },

  // ─── Finance ───────────────────────────────────────────────
  {
    key: 'finance.account', model: 'Account', label: 'Chart of Accounts', title: 'name', subtitle: 'code', list: ['code', 'name', 'type', 'parentId', 'isCash', 'isBank'],
    search: ['code', 'name'], refs: { parentId: 'finance.account', employeeId: 'hrm.employee', branchId: 'core.branch' },
    actions: [{ name: 'ledger', label: 'Ledger', path: 'finance/ledger/:id', opens: true, permission: 'finance.account.view' }],
  },
  { key: 'finance.journal', model: 'JournalEntry', label: 'Journal', title: 'number', subtitle: 'memo', list: ['number', 'date', 'memo', 'sourceType', 'amount'], amountField: 'amount', search: ['number', 'memo'], ops: [], printable: true, children: { lines: 'JournalLine' }, refs: { branchId: 'core.branch' } },
  {
    key: 'finance.cash', model: 'CashTransaction', label: 'Cash In / Transfers', title: 'number', subtitle: 'memo', list: ['number', 'date', 'fromAccountId', 'toAccountId', 'amount', 'memo'],
    refs: { fromAccountId: 'finance.account', toAccountId: 'finance.account', branchId: 'core.branch' }, number: { field: 'number', docType: 'CV', pattern: 'CV-{BR}-{YY}{MM}-{SEQ:4}' },
    readonly: ['journalId'], ops: ['create'], printable: true,
  },
  {
    key: 'finance.advance', model: 'Advance', label: 'Expense Advances', title: 'number', subtitle: 'purpose', scope: { kind: 'expense' },
    list: ['number', 'employeeId', 'amount', 'installments', 'installmentAmount', 'recovered', 'purpose', 'status', 'createdAt'], search: ['number', 'purpose'], refs: { employeeId: 'hrm.employee' },
    number: { field: 'number', docType: 'ADV', pattern: 'ADV-{YYYY}-{SEQ:5}' }, hidden: ['kind'],
    workflow: true, amountField: 'amount', owner: 'employeeId', readonly: ['branchId', 'departmentId', 'status', 'recovered', 'installmentAmount', 'disbursedAt'], editableWhen: EDIT_DRAFT, printable: true,
    statuses: ['draft', 'pending', 'approved', 'disbursement_pending', 'disbursed', 'settled', 'rejected'],
    actions: [
      { name: 'disburse', label: 'Prepare disbursement voucher', path: 'finance/advances/:id/disburse', when: ['approved'], fields: { accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] }, label: 'Pay from' }, notes: { type: 'text' } }, permission: 'finance.voucher.create' },
      { name: 'return', label: 'Record repayment', path: 'finance/advances/:id/return', when: ['disbursed'], permission: 'finance.payment.create', fields: REPAY_FIELDS },
    ],
  },
  {
    key: 'finance.loan', model: 'Advance', label: 'Salary Advances & Loans', title: 'number', subtitle: 'purpose', scope: { kind: 'salary' },
    list: ['number', 'employeeId', 'amount', 'installments', 'installmentAmount', 'recovered', 'status', 'createdAt'], search: ['number', 'purpose'], refs: { employeeId: 'hrm.employee' },
    number: { field: 'number', docType: 'LOAN', pattern: 'LOAN-{YYYY}-{SEQ:5}' }, hidden: ['kind'],
    workflow: true, amountField: 'amount', owner: 'employeeId', readonly: ['branchId', 'departmentId', 'status', 'recovered', 'installmentAmount', 'disbursedAt'], editableWhen: EDIT_DRAFT, printable: true,
    statuses: ['draft', 'pending', 'approved', 'disbursement_pending', 'disbursed', 'settled', 'rejected'],
    actions: [
      { name: 'disburse', label: 'Prepare disbursement voucher', path: 'finance/advances/:id/disburse', when: ['approved'], fields: { accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] }, label: 'Pay from' }, notes: { type: 'text' } }, permission: 'finance.voucher.create' },
      { name: 'return', label: 'Record repayment', path: 'finance/advances/:id/return', when: ['disbursed'], permission: 'finance.payment.create', fields: REPAY_FIELDS },
    ],
  },
  {
    autofill: { advanceId: { employeeId: 'employeeId' } },
    key: 'finance.claim', model: 'ExpenseClaim', label: 'Expense Claims', title: 'number', subtitle: 'notes', list: ['number', 'employeeId', 'mode', 'date', 'total', 'status'],
    search: ['number', 'notes'], refs: { employeeId: 'hrm.employee', advanceId: 'finance.advance' }, number: { field: 'number', docType: 'EXP', pattern: 'EXP-{YYYY}-{SEQ:5}' },
    workflow: true, amountField: 'total', owner: 'employeeId', children: { lines: 'ExpenseClaimLine' }, createPath: '/finance/claims/new',
    readonly: ['branchId', 'departmentId', 'status', 'total', 'fromAdvance', 'reimbursed', 'refundDue', 'approvedTotal', 'approvalNote', 'booked'], editableWhen: EDIT_DRAFT, printable: true,
    statuses: ['draft', 'pending', 'approved', 'payment_pending', 'partially_paid', 'paid', 'settled', 'rejected'],
    actions: [
      {
        // The unspent part of the advance comes back as cash; full settlement of the advance, any installments included.
        name: 'return_advance', label: 'Return remaining advance', path: 'finance/claims/:id/return-advance', when: ['settled'], permission: 'finance.payment.create',
        fields: { accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] }, label: 'Received into' } },
      },
      {
        name: 'adjust', label: 'Approve partially (cut lines)', path: 'finance/claims/:id/adjust', when: ['pending'], permission: 'finance.claim.approve',
        fields: {
          lines: {
            type: 'lines', required: true,
            columns: { lineId: { type: 'string', hidden: true }, description: { type: 'string', readonly: true }, claimed: { type: 'money', readonly: true }, approved: { type: 'money', required: true, label: 'Approve (0 = disallow)' } },
            prefill: { rel: 'lines', map: { lineId: 'id', description: 'description', claimed: 'amount+tax', approved: 'amount+tax' } },
          },
          note: { type: 'text', label: 'Reason (shown to the employee)' },
        },
      },
      { name: 'pay', label: 'Prepare reimbursement voucher', path: 'finance/claims/:id/pay', when: ['approved', 'partially_paid'], fields: { accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] }, label: 'Pay from' }, amount: { type: 'money', label: 'Amount now (blank = full balance)' }, notes: { type: 'text' } }, permission: 'finance.voucher.create' },
    ],
  },
  {
    autofill: { customerId: { partyName: 'name' }, vendorId: { partyName: 'name' }, employeeId: { partyName: 'name' } },
    key: 'payables.due', model: 'Due', label: 'All Dues', title: 'number', subtitle: 'description',
    list: ['number', 'direction', 'partyName', 'description', 'dueDate', 'amount', 'paid', 'status'], search: ['number', 'partyName', 'description'],
    number: { field: 'number', docType: 'DUE', pattern: 'DUE-{YYYY}-{SEQ:5}' }, readonly: ['paid', 'status', 'journalId', 'partyType'],
    enums: { direction: ['receivable', 'payable'], partyType: ['customer', 'vendor', 'employee', 'other'] },
    statuses: ['open', 'partially_paid', 'settled'], calendar: 'dueDate', ops: ['create'], printable: true,
    actions: [{ name: 'pay', label: 'Record payment', path: 'finance/dues/:id/pay', when: ['open', 'partially_paid'], fields: { amount: { type: 'money', required: true, from: 'amount-paid' }, accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] } }, methodId: { type: 'ref', ref: 'core.masterdata' } }, permission: 'finance.payment.create' }],
  },
  {
    key: 'finance.voucher', model: 'PaymentVoucher', label: 'Payment Vouchers', title: 'number', subtitle: 'purpose',
    list: ['number', 'purpose', 'employeeId', 'amount', 'accountId', 'status', 'createdAt'], search: ['number', 'notes'],
    refs: { employeeId: 'hrm.employee', accountId: 'finance.account', methodId: 'core.masterdata' },
    number: { field: 'number', docType: 'PV', pattern: 'PV-{YYYY}-{SEQ:5}' }, workflow: true, amountField: 'amount', owner: 'employeeId',
    readonly: ['status', 'purpose', 'sourceType', 'sourceId', 'employeeId', 'amount', 'breakdown', 'paidAt', 'journalId'], ops: [], editableWhen: ['draft', 'returned'], printable: true,
    enums: { purpose: ['advance_disbursement', 'loan_disbursement', 'claim_reimbursement'] },
    statuses: ['draft', 'pending', 'paid', 'rejected'],
  },
  {
    key: 'finance.payment', model: 'Payment', label: 'Payments', title: 'number', amountField: 'amount', list: ['number', 'date', 'direction', 'partyType', 'amount', 'refType', 'accountId'],
    refs: { accountId: 'finance.account', methodId: 'core.masterdata' }, number: { field: 'number', docType: 'PMT', pattern: 'PMT-{YYYY}-{SEQ:5}' }, ops: [], printable: true,
  },

  // ─── Inventory ─────────────────────────────────────────────
  {
    key: 'inventory.product', model: 'Product', label: 'Products', title: 'name', subtitle: 'sku', list: ['sku', 'name', 'categoryId', 'brand', 'price', 'reorderLevel', 'isActive'],
    search: ['sku', 'barcode', 'barcodes', 'name', 'brand', 'model'], barcode: 'barcode', refs: { categoryId: 'core.masterdata', unitId: 'core.masterdata', taxId: 'core.masterdata' },
    restricted: ['cost'], readonly: ['cost'], printable: true,
    actions: [{ name: 'label', label: 'Print label', path: 'print/inventory.product/:id?template=label', opens: true, permission: 'inventory.product.print' }],
  },
  { key: 'inventory.warehouse', model: 'Warehouse', label: 'Warehouses', title: 'name', subtitle: 'code', list: ['code', 'name', 'kind', 'branchId'], refs: { branchId: 'core.branch' } },
  { key: 'inventory.stock', model: 'StockLevel', label: 'Stock Levels', title: 'productId', list: ['productId', 'warehouseId', 'qty', 'avgCost'], refs: { productId: 'inventory.product', warehouseId: 'inventory.warehouse' }, restricted: ['avgCost'], ops: [] },
  { key: 'inventory.movement', model: 'StockMovement', label: 'Stock Ledger', title: 'type', list: ['at', 'productId', 'warehouseId', 'type', 'qty', 'unitCost', 'serial', 'refType'], refs: { productId: 'inventory.product', warehouseId: 'inventory.warehouse' }, restricted: ['unitCost'], ops: [], search: ['serial', 'type'] },
  {
    key: 'inventory.adjustment', model: 'StockAdjustment',
    lineColumns: { lines: { productId: { type: 'ref', ref: 'inventory.product', required: true, label: 'Product' }, qty: { type: 'number', required: true, label: 'Qty (+/− or counted)' }, serial: { type: 'string' }, unitCost: { type: 'money', label: 'Unit cost (stock in)' } } }, label: 'Adjustments & Transfers', title: 'number', list: ['number', 'kind', 'warehouseId', 'toWarehouseId', 'status', 'createdAt'],
    refs: { warehouseId: 'inventory.warehouse', toWarehouseId: 'inventory.warehouse' }, number: { field: 'number', docType: 'ADJ', pattern: 'ADJ-{YYYY}-{SEQ:5}' },
    workflow: true, readonly: WF, editableWhen: EDIT_DRAFT,
    actions: [{ name: 'post', label: 'Post to stock', path: 'inventory/adjustments/:id/post', when: ['approved'], permission: 'inventory.adjustment.approve' }],
  },
  {
    key: 'serials.item', model: 'SerialItem', label: 'Serial Register', title: 'serial', subtitle: 'status',
    list: ['serial', 'itemName', 'productId', 'status', 'location', 'holder', 'customerId', 'warrantyUntil'], search: ['serial', 'itemName', 'brand', 'model', 'location', 'holder', 'notes'], barcode: 'serial',
    refs: { productId: 'inventory.product', warehouseId: 'inventory.warehouse', vendorId: 'purchase.vendor', customerId: 'sales.customer', employeeId: 'hrm.employee' },
    // warehouse/vendor/receipt/sale are maintained by stock postings; everything else can be entered by hand.
    readonly: ['warehouseId', 'vendorId', 'receivedAt', 'soldAt'], ops: ['create', 'update', 'delete'], printable: true,
    autofill: { productId: { brand: 'brand', model: 'model', itemName: 'name' } },
    statuses: ['in_stock', 'issued', 'demo', 'rma', 'sold', 'out', 'scrapped'],
    actions: [
      { name: 'history', label: 'Full history', path: 'serials/:id/history-page', opens: true, permission: 'serials.item.view' },
      { name: 'label', label: 'Print serial label', path: 'print/serials.item/:id?template=label', opens: true, permission: 'serials.item.print' },
    ],
  },
  {
    key: 'sales.customer', model: 'Customer', label: 'Customers', title: 'name', subtitle: 'phone', list: ['code', 'name', 'phone', 'email', 'creditLimit'], search: ['code', 'name', 'phone', 'email', 'taxId'],
    number: { field: 'code', docType: 'CUS', pattern: 'C{SEQ:5}' }, group: 'repair',
    actions: [{ name: 'statement', label: 'Ledger', path: 'finance/statement/customer/:id', opens: true, permission: 'finance.statement.view' }],
  },
  {
    key: 'purchase.vendor', model: 'Vendor', label: 'Vendors', title: 'name', subtitle: 'phone', list: ['code', 'name', 'phone', 'email', 'paymentTerms'], search: ['code', 'name', 'phone'],
    number: { field: 'code', docType: 'VEN', pattern: 'V{SEQ:5}' },
    actions: [{ name: 'statement', label: 'Ledger', path: 'finance/statement/vendor/:id', opens: true, permission: 'finance.statement.view' }],
  },
  {
    key: 'purchase.requisition', model: 'PurchaseRequisition',
    lineColumns: { lines: { productId: { type: 'ref', ref: 'inventory.product', required: true, label: 'Product' }, qty: { type: 'number', required: true }, jobId: { type: 'ref', ref: 'repair.job', label: 'For job' }, note: { type: 'string' } } }, label: 'Requisitions', title: 'number', list: ['number', 'reason', 'status', 'createdAt'],
    number: { field: 'number', docType: 'PR', pattern: 'PR-{YYYY}-{SEQ:5}' }, workflow: true, readonly: ['status', 'poId'], editableWhen: EDIT_DRAFT,
    actions: [{ name: 'to-po', label: 'Convert to PO', path: 'purchase/requisitions/:id/to-po', when: ['approved'], fields: { vendorId: { type: 'ref', ref: 'purchase.vendor', required: true } }, permission: 'purchase.order.create' }],
  },
  {
    lineAutofill: { lines: { productId: { price: 'cost', taxRate: 'taxId>value.rate' } } },
    key: 'purchase.order', model: 'PurchaseOrder', label: 'Purchase Orders', title: 'number', list: ['number', 'vendorId', 'date', 'total', 'status'], search: ['number'],
    refs: { vendorId: 'purchase.vendor' }, number: { field: 'number', docType: 'PO', pattern: 'PO-{BR}-{YYYY}-{SEQ:5}' }, workflow: true, amountField: 'total',
    children: { lines: 'PurchaseOrderLine' }, readonly: ['status', 'subtotal', 'tax', 'total'], editableWhen: EDIT_DRAFT, printable: true,
    actions: [
      {
        name: 'receive', label: 'Receive goods (GRN)', path: 'purchase/orders/:id/receive', when: ['approved', 'partially_received'], permission: 'purchase.receipt.create',
        fields: {
          warehouseId: { type: 'ref', ref: 'inventory.warehouse', required: true },
          lines: {
            type: 'lines', required: true,
            columns: { lineId: { type: 'string', hidden: true }, productId: { type: 'ref', ref: 'inventory.product', readonly: true, label: 'Product' }, qty: { type: 'number', required: true, label: 'Receive qty' }, serials: { type: 'string', label: 'Serials (comma-separated)' } },
            prefill: { rel: 'lines', map: { lineId: 'id', productId: 'productId', qty: 'qty-receivedQty' }, keepIf: 'qty' },
          },
        },
      },
      {
        name: 'return', label: 'Return to vendor', path: 'purchase/orders/:id/return', when: ['partially_received', 'received'], permission: 'purchase.receipt.create',
        fields: {
          warehouseId: { type: 'ref', ref: 'inventory.warehouse', required: true },
          lines: {
            type: 'lines', required: true,
            columns: { lineId: { type: 'string', hidden: true }, productId: { type: 'ref', ref: 'inventory.product', readonly: true, label: 'Product' }, qty: { type: 'number', required: true, label: 'Return qty' }, serials: { type: 'string', label: 'Serials (comma-separated)' } },
            prefill: { rel: 'lines', map: { lineId: 'id', productId: 'productId', qty: 'receivedQty-returnedQty' }, keepIf: 'qty' },
          },
        },
      },
    ],
  },
  { key: 'purchase.receipt', model: 'GoodsReceipt', label: 'Goods Receipts', title: 'number', list: ['number', 'poId', 'warehouseId', 'createdAt'], refs: { poId: 'purchase.order', warehouseId: 'inventory.warehouse' }, ops: [], printable: true },
  {
    autofill: { poId: { vendorId: 'vendorId', amount: 'total' } },
    key: 'purchase.bill', model: 'VendorBill', label: 'Vendor Bills', title: 'number', subtitle: 'vendorRef', list: ['number', 'vendorId', 'date', 'dueDate', 'amount', 'paid', 'status'],
    refs: { vendorId: 'purchase.vendor', poId: 'purchase.order' }, number: { field: 'number', docType: 'BILL', pattern: 'BILL-{YYYY}-{SEQ:5}' }, readonly: ['paid', 'status'], editableWhen: ['open'],
    actions: [{ name: 'pay', label: 'Pay', path: 'purchase/bills/:id/pay', when: ['open', 'partially_paid'], fields: { amount: { type: 'money', required: true, from: 'amount-paid' }, accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] } }, methodId: { type: 'ref', ref: 'core.masterdata' } }, permission: 'finance.payment.create' }],
  },

  // ─── Repair ────────────────────────────────────────────────
  {
    key: 'repair.intake', model: 'Intake', label: 'Intakes', title: 'number', list: ['number', 'customerId', 'receivedAt', 'notes'], refs: { customerId: 'sales.customer' }, search: ['number'], ops: [], printable: true,
    actions: [
      { name: 'quote', label: 'Quotation for all units', path: 'repair/intakes/:id/quotation', permission: 'repair.quotation.create' },
      { name: 'invoice', label: 'Invoice all accepted units', path: 'repair/intakes/:id/invoice', permission: 'repair.invoice.create' },
      { name: 'deliver', label: 'Deliver all ready units', path: 'repair/intakes/:id/deliver', fields: { receivedBy: { type: 'string', label: 'Received by' } }, permission: 'repair.delivery.create' },
    ],
    related: [
      { resource: 'repair.job', field: 'intakeId', label: 'Units', columns: ['number', 'productType', 'model', 'serial', 'assetTag', 'status'] },
      { resource: 'repair.quotation', field: 'intakeId', label: 'Quotations', columns: ['number', 'version', 'total', 'status'] },
      { resource: 'repair.invoice', field: 'intakeId', label: 'Invoices', columns: ['number', 'date', 'total', 'paid', 'status'] },
      { resource: 'repair.delivery', field: 'intakeId', label: 'Delivery orders', columns: ['number', 'receivedBy', 'createdAt'] },
    ],
  },
  {
    key: 'repair.job', model: 'Job', label: 'Jobs', title: 'number', subtitle: 'model', scope: { kind: 'repair' },
    related: [
      { resource: 'repair.quotation', field: 'jobId', label: 'Quotations', columns: ['number', 'version', 'total', 'status'] },
      { resource: 'repair.invoice', field: 'jobId', label: 'Invoices', columns: ['number', 'date', 'total', 'paid', 'status'] },
    ],
    list: ['number', 'customerId', 'productType', 'model', 'serial', 'assetTag', 'technicianId', 'status', 'expectedAt'],
    search: ['number', 'serial', 'assetTag', 'brand', 'model', 'productType', 'firmwareVersion', 'fault'], barcode: 'number',
    refs: { customerId: 'sales.customer', technicianId: 'hrm.employee', intakeId: 'repair.intake', vendorId: 'purchase.vendor', parentJobId: 'repair.job' },
    hidden: ['passwordEnc', 'trackToken', 'vehicleId', 'odometer'], readonly: ['status', 'diagnosis', 'deliveredAt', 'closedAt', 'kind', 'testResults', 'intakeId', 'condition'],
    ops: ['update'], printable: true, owner: 'technicianId', timeTracking: true, calendar: 'expectedAt',
    statuses: ['received', 'assigned', 'diagnosing', 'diagnosed', 'quotation_sent', 'approved', 'parts_pending', 'in_repair', 'qc', 'ready', 'delivered', 'closed'],
    actions: [
      // Statuses follow the work (assign, diagnose, quote, parts, QC, deliver, payment); only the dead end is set by hand.
      { name: 'status', label: 'Mark not repairable', path: 'repair/jobs/:id/status', when: ['diagnosing', 'diagnosed', 'in_repair'], fields: { status: { type: 'enum', options: ['not_repairable'], required: true, label: 'Outcome' }, note: { type: 'text', required: true, label: 'Reason (shown to the customer)' } }, permission: 'repair.job.manage' },
      { name: 'assign', label: 'Assign technician', path: 'repair/jobs/:id/assign', fields: { technicianId: { type: 'ref', ref: 'hrm.employee', required: true } }, permission: 'repair.job.manage' },
      {
        name: 'diagnose', label: 'Diagnosis & quote', path: 'repair/jobs/:id/diagnose',
        fields: {
          findings: { type: 'text', required: true },
          labor: { type: 'lines', columns: { serviceId: { type: 'ref', ref: 'core.masterdata', required: true, label: 'Service', filters: { type: 'service_rate' } }, qty: { type: 'number', required: true } } },
          parts: { type: 'lines', columns: { productId: { type: 'ref', ref: 'inventory.product', required: true, label: 'Part' }, qty: { type: 'number', required: true } } },
        },
      },
      { name: 'issue', label: 'Issue parts', path: 'repair/jobs/:id/issue-parts', fields: { warehouseId: { type: 'ref', ref: 'inventory.warehouse', required: true } }, permission: 'inventory.movement.create' },
      { name: 'return-parts', label: 'Return unused parts', path: 'repair/jobs/:id/return-parts', fields: { warehouseId: { type: 'ref', ref: 'inventory.warehouse', required: true } }, permission: 'inventory.movement.create' },
      {
        name: 'test', label: 'Record QC test', path: 'repair/jobs/:id/test', when: ['in_repair', 'qc'],
        fields: {
          rfPowerW: { type: 'number' }, rxSensitivity: { type: 'string' }, freqErrorHz: { type: 'number' }, vswr: { type: 'number' },
          audioOk: { type: 'bool' }, firmwareAfter: { type: 'string' }, pass: { type: 'bool', required: true }, notes: { type: 'text' },
        },
      },
      { name: 'invoice', label: 'Create invoice', path: 'repair/jobs/:id/invoice', when: ['approved', 'parts_pending', 'in_repair', 'qc', 'ready', 'delivered', 'returned_unrepaired', 'not_repairable'], permission: 'repair.invoice.create' },
      { name: 'deliver', label: 'Deliver', path: 'repair/jobs/:id/deliver', when: ['ready', 'returned_unrepaired', 'not_repairable', 'declined'], fields: { receivedBy: { type: 'string' } } },
      { name: 'comeback', label: 'Open comeback job', path: 'repair/jobs/:id/comeback', when: ['delivered', 'closed'], fields: { fault: { type: 'text', required: true } }, permission: 'repair.job.create' },
      { name: 'tag', label: 'Print job tag', path: 'print/repair.job/:id?template=label', opens: true, permission: 'repair.job.print' },
      { name: 'password', label: 'Reveal device PIN / password', path: 'repair/jobs/:id/password', permission: 'repair.job.manage' },
    ],
  },
  {
    key: 'repair.quotation', model: 'Quotation',
    lineColumns: { lines: { jobId: { type: 'string', hidden: true }, kind: { type: 'enum', options: ['labor', 'part'], required: true }, refId: { type: 'string', hidden: true }, description: { type: 'string', required: true }, qty: { type: 'number', required: true }, price: { type: 'money', required: true }, taxRate: { type: 'number', label: 'Tax %' } } }, label: 'Quotations', title: 'number', list: ['number', 'jobId', 'version', 'total', 'validUntil', 'status'],
    refs: { jobId: 'repair.job', intakeId: 'repair.intake', customerId: 'sales.customer' }, number: { field: 'number', docType: 'QT', pattern: 'QT-{YYYY}-{SEQ:5}' }, workflow: true, amountField: 'total',
    readonly: ['status', 'subtotal', 'tax', 'total', 'version', 'decidedAt'], editableWhen: EDIT_DRAFT, printable: true,
    actions: [
      { name: 'send', label: 'Mark sent to customer', path: 'repair/quotations/:id/send', when: ['draft', 'approved'] },
      { name: 'invoice', label: 'Create invoice', path: 'repair/quotations/:id/invoice', when: ['accepted'], permission: 'repair.invoice.create' },
      { name: 'decide', label: 'Customer decision', path: 'repair/quotations/:id/decision', when: ['sent', 'approved', 'draft'], fields: { accepted: { type: 'bool', required: true }, via: { type: 'enum', options: ['signature', 'link', 'phone'], required: true } } },
    ],
  },
  {
    key: 'repair.invoice', model: 'Invoice', label: 'Invoices', title: 'number', list: ['number', 'customerId', 'jobId', 'intakeId', 'date', 'total', 'paid', 'status'], search: ['number'],
    refs: { customerId: 'sales.customer', jobId: 'repair.job', intakeId: 'repair.intake', quotationId: 'repair.quotation' }, number: { field: 'number', docType: 'INV', pattern: 'INV-{BR}-{YY}{MM}-{SEQ:4}' },
    readonly: ['status', 'paid', 'credited', 'journalId', 'subtotal', 'tax', 'total'], ops: [], printable: true, barcode: 'number',
    actions: [
      { name: 'pay', label: 'Receive payment', path: 'repair/invoices/:id/pay', when: ['unpaid', 'partially_paid'], fields: { amount: { type: 'money', required: true, from: 'total-paid' }, accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] } }, methodId: { type: 'ref', ref: 'core.masterdata' } }, permission: 'finance.payment.create' },
      { name: 'pos', label: 'POS receipt', path: 'print/repair.invoice/:id?size=80', opens: true, permission: 'repair.invoice.print' },
    ],
  },
  {
    autofill: { invoiceId: { amount: 'total-credited' } },
    key: 'repair.creditnote', model: 'CreditNote', label: 'Refunds / Credit Notes', title: 'number', list: ['number', 'invoiceId', 'amount', 'status'],
    refs: { invoiceId: 'repair.invoice', reasonId: 'core.masterdata' }, number: { field: 'number', docType: 'CN', pattern: 'CN-{YYYY}-{SEQ:5}' }, workflow: true, amountField: 'amount',
    readonly: WF, editableWhen: EDIT_DRAFT, printable: true,
    actions: [{ name: 'post', label: 'Post refund', path: 'repair/creditnotes/:id/post', when: ['approved'], fields: { accountId: { type: 'ref', ref: 'finance.account', filters: { $or: [{ isCash: true }, { isBank: true }] } } }, permission: 'repair.creditnote.approve' }],
  },
  { key: 'repair.delivery', model: 'DeliveryOrder', label: 'Delivery Orders', title: 'number', list: ['number', 'customerId', 'intakeId', 'receivedBy', 'createdAt'], refs: { customerId: 'sales.customer', intakeId: 'repair.intake' }, ops: [], printable: true },

  // ─── Fleet ─────────────────────────────────────────────────
  {
    key: 'fleet.vehicle', model: 'Vehicle', label: 'Vehicles', title: 'plate', subtitle: 'model', list: ['plate', 'make', 'model', 'year', 'driverId', 'odometer', 'status'],
    search: ['plate', 'vin', 'engineNo', 'make', 'model'], barcode: 'plate', refs: { driverId: 'hrm.employee', branchId: 'core.branch' }, printable: true,
    actions: [
      { name: 'maintenance', label: 'Open maintenance job', path: 'fleet/vehicles/:id/maintenance', fields: { fault: { type: 'text', required: true }, vendorId: { type: 'ref', ref: 'purchase.vendor' } }, permission: 'fleet.maintenance.create' },
      { name: 'cost', label: 'Cost of ownership', path: 'fleet/vehicles/:id/cost', opens: true },
    ],
  },
  {
    key: 'fleet.maintenance', model: 'Job', label: 'Maintenance Jobs', title: 'number', subtitle: 'fault', scope: { kind: 'fleet' }, group: 'fleet',
    list: ['number', 'vehicleId', 'fault', 'vendorId', 'technicianId', 'odometer', 'status', 'createdAt'], search: ['number', 'serial', 'fault'], barcode: 'number',
    refs: { vehicleId: 'fleet.vehicle', technicianId: 'hrm.employee', vendorId: 'purchase.vendor' },
    hidden: ['passwordEnc', 'trackToken', 'customerId', 'intakeId', 'assetTag', 'firmwareVersion', 'frequencyBand', 'zeroized', 'accessories', 'condition', 'warranty', 'warrantyDays', 'parentJobId', 'productType'],
    readonly: ['status', 'diagnosis', 'deliveredAt', 'closedAt', 'kind', 'testResults', 'vehicleId'], ops: ['update'], printable: true, timeTracking: true,
    statuses: ['received', 'assigned', 'diagnosing', 'diagnosed', 'approved', 'parts_pending', 'in_repair', 'qc', 'ready', 'delivered', 'closed'],
    actions: [
      { name: 'status', label: 'Change status', path: 'repair/jobs/:id/status', fields: { status: { type: 'string', required: true }, note: { type: 'text' } } },
      { name: 'assign', label: 'Assign mechanic', path: 'repair/jobs/:id/assign', fields: { technicianId: { type: 'ref', ref: 'hrm.employee', required: true } }, permission: 'fleet.maintenance.manage' },
      { name: 'issue', label: 'Issue parts', path: 'repair/jobs/:id/issue-parts', fields: { warehouseId: { type: 'ref', ref: 'inventory.warehouse', required: true } }, permission: 'inventory.movement.create' },
    ],
  },
  { autofill: { vehicleId: { driverId: 'driverId', startOdo: 'odometer' } }, key: 'fleet.trip', model: 'Trip', label: 'Trips', title: 'route', calendar: 'startAt', list: ['vehicleId', 'driverId', 'startAt', 'startOdo', 'endOdo', 'purpose'], refs: { vehicleId: 'fleet.vehicle', driverId: 'hrm.employee' }, owner: 'driverId' },
  { autofill: { vehicleId: { odometer: 'odometer' } }, key: 'fleet.fuel', model: 'FuelLog', label: 'Fuel Logs', title: 'station', list: ['date', 'vehicleId', 'liters', 'cost', 'odometer', 'paidById'], refs: { vehicleId: 'fleet.vehicle', paidById: 'hrm.employee', claimId: 'finance.claim' }, readonly: ['claimId'] },
  { autofill: { vehicleId: { odometer: 'odometer' } }, key: 'fleet.event', model: 'VehicleEvent', label: 'Tyres, Accidents & Fines', title: 'type', list: ['date', 'vehicleId', 'type', 'amount', 'details'], refs: { vehicleId: 'fleet.vehicle' } },

  // ─── Gatepass ──────────────────────────────────────────────
  {
    lineAutofill: { lines: { productId: { description: 'name' } } }, autofill: { customerId: { partyName: 'name', contactPerson: 'contactName', contactPhone: 'phone' }, vendorId: { partyName: 'name', contactPerson: 'contactName', contactPhone: 'phone' } },
    key: 'gatepass.pass', model: 'Gatepass', label: 'Gatepasses', title: 'number', subtitle: 'partyName', list: ['number', 'type', 'partyName', 'expectedReturn', 'status', 'createdAt'],
    search: ['number', 'partyName', 'contactPerson'], barcode: 'number',
    refs: { customerId: 'sales.customer', vendorId: 'purchase.vendor', vehicleId: 'fleet.vehicle', fromWarehouseId: 'inventory.warehouse', toWarehouseId: 'inventory.warehouse' },
    number: { field: 'number', docType: 'GP', pattern: 'GP-{BR}-{YY}{MM}-{SEQ:4}' }, workflow: true, children: { lines: 'GatepassLine' },
    readonly: ['status', 'checkedOutAt', 'checkedInAt'], editableWhen: EDIT_DRAFT, printable: true,
    statuses: ['draft', 'pending', 'approved', 'out', 'partially_returned', 'returned', 'closed', 'converted'],
    actions: [
      { name: 'out', label: 'Gate check-out', path: 'gatepass/:id/check', when: ['approved'], fields: { direction: { type: 'enum', options: ['out'], required: true }, notes: { type: 'string' } }, permission: 'gatepass.check.create' },
      {
        name: 'in', label: 'Gate check-in / return', path: 'gatepass/:id/check', when: ['out', 'partially_returned', 'approved'], permission: 'gatepass.check.create',
        fields: {
          direction: { type: 'enum', options: ['in'], required: true },
          lines: {
            type: 'lines',
            columns: { lineId: { type: 'string', hidden: true }, productId: { type: 'ref', ref: 'inventory.product', readonly: true, label: 'Item' }, serial: { type: 'string', readonly: true }, qty: { type: 'number', required: true, label: 'Returned qty' }, condition: { type: 'enum', options: ['ok', 'damaged', 'missing_accessories'] } },
            prefill: { rel: 'lines', map: { lineId: 'id', productId: 'productId', serial: 'serial', qty: 'qty-returnedQty-soldQty', condition: '=ok' }, keepIf: 'qty' },
          },
          notes: { type: 'string' },
        },
      },
      {
        name: 'sale', label: 'Convert demo to sale', path: 'gatepass/:id/convert', when: ['out', 'partially_returned'], permission: 'repair.invoice.create',
        fields: {
          customerId: { type: 'ref', ref: 'sales.customer', required: true, from: 'customerId' },
          lines: {
            type: 'lines', required: true,
            columns: { lineId: { type: 'string', hidden: true }, productId: { type: 'ref', ref: 'inventory.product', readonly: true, label: 'Item' }, serial: { type: 'string', readonly: true }, qty: { type: 'number', required: true, label: 'Sell qty' }, price: { type: 'money', label: 'Price (blank = list price)' } },
            prefill: { rel: 'lines', map: { lineId: 'id', productId: 'productId', serial: 'serial', qty: 'qty-returnedQty-soldQty' }, keepIf: 'qty' },
          },
        },
      },
      { name: 'pos', label: 'POS slip', path: 'print/gatepass.pass/:id?size=80', opens: true, permission: 'gatepass.pass.print' },
    ],
  },
  { key: 'gatepass.check', model: 'GateCheck', label: 'Gate Checks', title: 'direction', list: ['at', 'gatepassId', 'direction', 'guardId', 'notes'], refs: { gatepassId: 'gatepass.pass', guardId: 'core.user' }, ops: [] },

  // ─── Utilities: sites → connections → readings & bills (bills book a payable on P & R) ───
  {
    key: 'utilities.site', model: 'UtilitySite', label: 'Sites', title: 'name', subtitle: 'address',
    list: ['code', 'name', 'address', 'contactPerson', 'phone', 'status'], search: ['code', 'name', 'address', 'contactPerson'],
    number: { field: 'code', docType: 'SITE', pattern: 'S-{SEQ:4}' }, enums: { status: ['active', 'closed'] }, statuses: ['active', 'closed'],
    related: [{ resource: 'utilities.connection', field: 'siteId', label: 'Connections', columns: ['name', 'type', 'provider', 'accountNo', 'meterNo', 'status'] }],
  },
  {
    autofill: { vendorId: { provider: 'name' } },
    key: 'utilities.connection', model: 'UtilityConnection', label: 'Connections', title: 'name', subtitle: 'accountNo',
    list: ['name', 'siteId', 'type', 'provider', 'accountNo', 'meterNo', 'billingDay', 'status'], search: ['name', 'provider', 'accountNo', 'meterNo'],
    refs: { siteId: 'utilities.site', vendorId: 'purchase.vendor', accountId: 'finance.account' },
    enums: { type: ['electricity', 'gas', 'water', 'internet', 'phone', 'sewerage', 'other'], status: ['active', 'suspended', 'disconnected'] }, statuses: ['active', 'suspended', 'disconnected'],
    related: [
      { resource: 'utilities.bill', field: 'connectionId', label: 'Bills', columns: ['number', 'billDate', 'dueDate', 'units', 'total', 'paid', 'status'] },
      { resource: 'utilities.reading', field: 'connectionId', label: 'Meter readings', columns: ['date', 'reading', 'consumption', 'meterReplaced'] },
    ],
    actions: [
      { name: 'reading', label: 'Add meter reading', path: 'utilities/connections/:id/reading', permission: 'utilities.reading.create',
        fields: { date: { type: 'date', required: true }, reading: { type: 'number', required: true }, meterReplaced: { type: 'bool', label: 'New meter (restart count)' }, notes: { type: 'string' } } },
      { name: 'bill', label: 'Record bill', path: 'utilities/connections/:id/bill', permission: 'utilities.bill.create',
        fields: {
          billDate: { type: 'date', required: true }, billRef: { type: 'string', label: 'Provider bill no.' }, periodFrom: { type: 'date' }, periodTo: { type: 'date' },
          units: { type: 'number', label: 'Units (blank = from readings)' }, energyCharge: { type: 'money', label: 'Usage charge (blank = units × tariff)' },
          fixedCharge: { type: 'money', label: 'Fixed / line rent (blank = connection default)' }, tax: { type: 'money' }, otherCharges: { type: 'money' }, arrears: { type: 'money' },
          dueDate: { type: 'date', label: 'Due date (blank = bill date + due days)' }, lateAmount: { type: 'money', label: 'Amount after due date' },
        } },
    ],
  },
  {
    key: 'utilities.reading', model: 'UtilityReading', label: 'Meter Readings', title: 'date', subtitle: 'reading',
    list: ['date', 'connectionId', 'reading', 'previous', 'consumption', 'meterReplaced'], refs: { connectionId: 'utilities.connection' },
    readonly: ['previous', 'consumption'],
  },
  {
    key: 'utilities.bill', model: 'UtilityBill', label: 'Utility Bills', title: 'number', subtitle: 'billRef',
    list: ['number', 'connectionId', 'siteId', 'billDate', 'dueDate', 'units', 'total', 'paid', 'status'], search: ['number', 'billRef', 'notes'],
    refs: { connectionId: 'utilities.connection', siteId: 'utilities.site', dueId: 'payables.due' },
    number: { field: 'number', docType: 'UB', pattern: 'UB-{YYYY}-{SEQ:5}' }, amountField: 'total', calendar: 'dueDate', printable: true,
    readonly: ['siteId', 'units', 'total', 'paid', 'status', 'dueId', 'paidAt'], ops: ['create'],
    statuses: ['unpaid', 'partially_paid', 'paid', 'disputed'],
    actions: [
      { name: 'pay', label: 'Pay bill', path: 'utilities/bills/:id/pay', when: ['unpaid', 'partially_paid'], permission: 'finance.payment.create',
        fields: { amount: { type: 'money', required: true, from: 'total-paid' }, accountId: { type: 'ref', ref: 'finance.account', required: true, filters: { $or: [{ isCash: true }, { isBank: true }] }, label: 'Paid from' }, methodId: { type: 'ref', ref: 'core.masterdata' } } },
      { name: 'dispute', label: 'Mark disputed', path: 'utilities/bills/:id/dispute', when: ['unpaid', 'partially_paid'], permission: 'utilities.bill.update', fields: { reason: { type: 'text', required: true } } },
      { name: 'undispute', label: 'Resolve dispute', path: 'utilities/bills/:id/dispute', when: ['disputed'], permission: 'utilities.bill.update' },
    ],
  },
  // ─── Catalog (brochures & presentations) ───
  {
    key: 'catalog.item', model: 'CatalogItem', label: 'Catalog Items', title: 'name', subtitle: 'tagline', rich: ['summary', 'description', 'customHtml'],
    list: ['code', 'name', 'kind', 'category', 'status', 'updatedAt'], search: ['code', 'name', 'category', 'tagline', 'summary'],
    refs: { productId: 'inventory.product' }, number: { field: 'code', docType: 'CAT', pattern: 'CAT-{SEQ:4}' },
    enums: { kind: ['product', 'solution', 'service'], status: ['draft', 'published'] }, statuses: ['draft', 'published'],
    actions: [
      { name: 'brochure', label: 'Brochure (PDF)', path: 'catalog/brochure?ids=:id&format=pdf', opens: true, permission: 'catalog.item.print' },
      { name: 'brochure-html', label: 'Brochure (print preview)', path: 'catalog/brochure?ids=:id', opens: true, permission: 'catalog.item.print' },
      { name: 'pptx', label: 'Presentation (PowerPoint)', path: 'catalog/presentation?ids=:id', opens: true, permission: 'catalog.item.export' },
    ],
    bulk: [
      { label: 'Brochure (PDF)', path: 'catalog/brochure?format=pdf', permission: 'catalog.item.print' },
      { label: 'Presentation (PowerPoint)', path: 'catalog/presentation', permission: 'catalog.item.export' },
      { label: 'Open in builder', path: '/catalog/builder', permission: 'catalog.item.print' },
    ],
  },

  // ─── Reports ───────────────────────────────────────────────
  { key: 'reports.report', model: 'SavedReport', label: 'Saved Reports', title: 'name', list: ['name', 'description', 'schedule'], owner: 'createdById' },
  { key: 'reports.dashboard', model: 'Dashboard', label: 'Dashboards', title: 'name', list: ['name', 'roleId', 'userId'], refs: { roleId: 'core.role', userId: 'core.user' } },
];

/** Owner fields that hold an Employee id (matched against the user's employee profile). */
export const EMPLOYEE_OWNERS = ['employeeId', 'assigneeId', 'technicianId', 'driverId', 'paidById'];

/** Foreign keys that mean the same thing everywhere; applied when a resource doesn't map the field itself. */
export const DEFAULT_REFS: Record<string, string> = {
  branchId: 'core.branch', departmentId: 'core.department', designationId: 'core.designation', employeeId: 'hrm.employee',
  customerId: 'sales.customer', vendorId: 'purchase.vendor', productId: 'inventory.product', warehouseId: 'inventory.warehouse',
  vehicleId: 'fleet.vehicle', jobId: 'repair.job', accountId: 'finance.account', headId: 'core.masterdata', advanceId: 'finance.advance',
  invoiceId: 'repair.invoice', poId: 'purchase.order', gatepassId: 'gatepass.pass', leaveTypeId: 'hrm.leavetype', shiftId: 'hrm.shift',
  stationId: 'hrm.station', technicianId: 'hrm.employee', assigneeId: 'hrm.employee', driverId: 'hrm.employee', paidById: 'hrm.employee',
  managerId: 'hrm.employee', userId: 'core.user', roleId: 'core.role', methodId: 'core.masterdata', reasonId: 'core.masterdata',
  categoryId: 'core.masterdata', unitId: 'core.masterdata', taxId: 'core.masterdata', fromAccountId: 'finance.account', toAccountId: 'finance.account',
  fromWarehouseId: 'inventory.warehouse', toWarehouseId: 'inventory.warehouse', parentId: 'finance.account', quotationId: 'repair.quotation',
};

/** Fixed choices shared by many resources. */
const E = {
  status: undefined,
  employeeType: ['permanent', 'contract', 'intern'],
  employeeStatus: ['active', 'on_leave', 'resigned', 'terminated'],
  gender: ['male', 'female', 'other'],
  priority: ['low', 'medium', 'high', 'urgent'],
  taskStatus: ['todo', 'in_progress', 'review', 'done', 'blocked'],
  recurrence: ['daily', 'weekly', 'monthly'],
};
const ENUMS: Record<string, Record<string, string[]>> = {
  'hrm.employee': { status: E.employeeStatus, gender: E.gender }, // type: Master Data 'employee_type'
  'hrm.task': { priority: E.priority, status: E.taskStatus, recurrence: E.recurrence },
  'hrm.event': { type: ['onboarding', 'transfer', 'promotion', 'increment', 'resignation', 'termination', 'exit_clearance'] },
  'hrm.document': { entityType: ['hrm.employee', 'fleet.vehicle'], type: ['cnic', 'passport', 'contract', 'license', 'registration', 'insurance', 'token_tax', 'fitness', 'other'] },
  'finance.account': { type: ['asset', 'liability', 'equity', 'income', 'expense'] },
  'finance.advance': { kind: ['expense', 'salary'] },
  'finance.claim': { mode: ['direct', 'against_advance'] },
  'inventory.warehouse': { kind: ['normal', 'demo', 'repair', 'vendor', 'scrap', 'transit'] },
  'inventory.adjustment': { kind: ['adjustment', 'transfer', 'damaged', 'count'] },
  'sales.customer': { kind: ['individual', 'company'] },
  'fleet.vehicle': { ownership: ['owned', 'leased', 'rented'], status: ['active', 'in_maintenance', 'inactive', 'sold'], fuelType: ['petrol', 'diesel', 'cng', 'hybrid', 'electric'] },
  'fleet.event': { type: ['tyre', 'battery', 'accident', 'fine', 'insurance', 'tax', 'other'] },
  'gatepass.pass': { type: ['outward_returnable', 'outward_non_returnable', 'inward', 'demo_out', 'repair_out', 'transfer'] },
  'core.customfield': { type: ['string', 'number', 'date', 'bool', 'enum', 'file'] },
  'core.template': { kind: ['print', 'notification'] },
  'core.sequence': { reset: ['never', 'yearly', 'monthly'] },
  'reports.report': { schedule: ['daily', 'weekly', 'monthly'] },
};
for (const r of RESOURCES) r.enums = { ...ENUMS[r.key], ...r.enums };

export const RESOURCE_MAP: Record<string, ResourceDef> = Object.fromEntries(RESOURCES.map((r) => [r.key, r]));
export const moduleOf = (key: string) => key.split('.')[0];

/** Permission-only resources (no generic screen). */
/** Ledgers stay append-only even for a record override: editing them would silently break balances and the audit trail. */
export const IMMUTABLE = ['core.audit', 'finance.journal', 'inventory.movement', 'inventory.stock'];

export const EXTRA_RESOURCES = [
  /** core.record.manage = super-admin override: edit/delete any record, locked or not, including read-only fields. */
  'core.record', 'core.approval', 'core.module', 'core.attachment', 'core.search',
  'finance.statement', 'finance.report', 'inventory.movement', 'purchase.receipt',
  'repair.dashboard', 'fleet.dashboard', 'gatepass.check', 'reports.builder',
];
