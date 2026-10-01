/**
 * What each module's A4 document shows: its proper title, whose document it is (party box),
 * grouped detail sections and the signature boxes. Field names that a record doesn't have are skipped,
 * and any remaining printable fields land in "Other details", so a profile can't hide data by omission.
 */
export interface PrintProfile {
  title: string;
  /** Field holding the counter-party; its name/address/phone print in the "To" box. */
  party?: { field: string; label: string };
  sections: [string, string[]][];
  signatures?: string[];
  /** Print the grand total in words (money documents). */
  words?: boolean;
  note?: string;
}

const EQUIPMENT: [string, string[]] = ['Equipment', ['productType', 'brand', 'model', 'serial', 'assetTag', 'firmwareVersion', 'frequencyBand', 'accessories', 'zeroized', 'warranty', 'warrantyDays']];

export const PRINT_PROFILES: Record<string, PrintProfile> = {
  'repair.job': {
    title: 'Job Card', party: { field: 'customerId', label: 'Customer' },
    sections: [EQUIPMENT, ['Fault & work', ['fault', 'condition', 'diagnosis']], ['Job', ['intakeId', 'technicianId', 'vendorId', 'parentJobId', 'expectedAt', 'deliveredAt', 'closedAt']]],
    signatures: ['Customer', 'Received by', 'Technician'],
    note: 'Units not collected within 60 days of the ready notice may be disposed of. Data on devices is the customer\'s responsibility.',
  },
  'fleet.maintenance': {
    title: 'Vehicle Maintenance Job', sections: [['Vehicle', ['vehicleId', 'odometer']], ['Work', ['fault', 'diagnosis', 'technicianId', 'vendorId', 'expectedAt', 'closedAt']]],
    signatures: ['Driver', 'Workshop', 'Fleet manager'],
  },
  'repair.intake': { title: 'Equipment Intake Receipt', party: { field: 'customerId', label: 'Customer' }, sections: [['Intake', ['receivedAt', 'notes']]], signatures: ['Customer', 'Received by'] },
  'repair.quotation': {
    title: 'Quotation', party: { field: 'customerId', label: 'Quotation for' }, sections: [['Reference', ['jobId', 'intakeId', 'version', 'validUntil', 'decisionVia', 'decidedAt']]],
    signatures: ['Prepared by', 'Customer acceptance'], words: true,
    note: 'Prices are valid until the date shown. Work starts on written acceptance of this quotation.',
  },
  'repair.invoice': {
    title: 'Tax Invoice', party: { field: 'customerId', label: 'Bill to' }, sections: [['Reference', ['date', 'jobId', 'intakeId', 'quotationId']]],
    signatures: ['Authorised signatory', 'Received by'], words: true,
  },
  'repair.creditnote': { title: 'Credit Note', sections: [['Credit', ['invoiceId', 'reasonId', 'refundCash', 'notes']]], signatures: ['Prepared by', 'Approved by'], words: true },
  'repair.delivery': { title: 'Delivery Order', party: { field: 'customerId', label: 'Deliver to' }, sections: [['Delivery', ['intakeId', 'jobIds', 'receivedBy', 'checklist']]], signatures: ['Delivered by', 'Received by (name & signature)'] },
  'purchase.requisition': { title: 'Purchase Requisition', sections: [['Request', ['reason', 'poId']]], signatures: ['Requested by', 'Approved by'] },
  'purchase.order': {
    title: 'Purchase Order', party: { field: 'vendorId', label: 'Supplier' }, sections: [['Order', ['date', 'expectedAt', 'notes']]],
    signatures: ['Prepared by', 'Approved by', 'Supplier acknowledgement'], words: true,
    note: 'Please quote the PO number on all invoices and delivery notes.',
  },
  'purchase.receipt': { title: 'Goods Received Note', sections: [['Receipt', ['poId', 'warehouseId']]], signatures: ['Received by', 'Checked by'] },
  'purchase.bill': { title: 'Vendor Bill', party: { field: 'vendorId', label: 'Supplier' }, sections: [['Bill', ['vendorRef', 'poId', 'date', 'dueDate']]], signatures: ['Verified by', 'Approved by'], words: true },
  'gatepass.pass': {
    title: 'Gate Pass', party: { field: 'customerId', label: 'Party' },
    sections: [['Movement', ['type', 'partyName', 'vendorId', 'contactPerson', 'contactPhone', 'purpose', 'fromWarehouseId', 'toWarehouseId', 'expectedReturn']], ['Transport', ['vehicleId', 'carrier', 'checkedOutAt', 'checkedInAt']]],
    signatures: ['Issued by', 'Authorised by', 'Security (out)', 'Security (in)'],
  },
  'finance.voucher': { title: 'Payment Voucher', party: { field: 'employeeId', label: 'Pay to' }, sections: [['Payment', ['purpose', 'accountId', 'methodId', 'departmentId', 'paidAt', 'notes']]], signatures: ['Prepared by', 'Checked by', 'Approved by', 'Received by'], words: true },
  'finance.payment': { title: 'Payment Receipt', sections: [['Payment', ['date', 'direction', 'partyType', 'refType', 'methodId', 'accountId', 'reference']]], signatures: ['Received by', 'Authorised by'], words: true },
  'finance.cash': { title: 'Cash Transfer', sections: [['Transfer', ['date', 'fromAccountId', 'toAccountId', 'memo']]], signatures: ['Prepared by', 'Approved by', 'Received by'], words: true },
  'finance.advance': { title: 'Expense Advance', party: { field: 'employeeId', label: 'Employee' }, sections: [['Advance', ['purpose', 'departmentId', 'disbursedAt']], ['Repayment plan', ['installments', 'installmentAmount', 'recovered']]], signatures: ['Employee', 'Approved by', 'Accounts'], words: true },
  'finance.loan': { title: 'Salary Advance / Loan', party: { field: 'employeeId', label: 'Employee' }, sections: [['Terms', ['purpose', 'installments', 'installmentAmount', 'recovered', 'disbursedAt']]], signatures: ['Employee', 'HR', 'Approved by', 'Accounts'], words: true },
  'finance.claim': {
    title: 'Expense Claim', party: { field: 'employeeId', label: 'Claimant' },
    sections: [['Claim', ['date', 'mode', 'advanceId', 'departmentId', 'notes']], ['Settlement', ['approvedTotal', 'approvalNote', 'fromAdvance', 'reimbursed', 'refundDue']]],
    signatures: ['Claimant', 'Approved by', 'Accounts'], words: true,
  },
  'payables.due': { title: 'Payable / Receivable', sections: [['Due', ['direction', 'partyName', 'description', 'dueDate', 'accountId']]], signatures: ['Prepared by', 'Approved by'], words: true },
  'utilities.bill': {
    title: 'Utility Bill', sections: [['Connection', ['connectionId', 'siteId', 'billRef']], ['Period & usage', ['periodFrom', 'periodTo', 'billDate', 'dueDate', 'units']], ['Charges', ['energyCharge', 'fixedCharge', 'tax', 'otherCharges', 'arrears', 'lateAmount', 'paidAt', 'notes']]],
    signatures: ['Verified by', 'Approved by', 'Paid by'], words: true,
  },
  'inventory.adjustment': { title: 'Stock Adjustment', sections: [['Adjustment', ['kind', 'warehouseId', 'toWarehouseId', 'reason']]], signatures: ['Prepared by', 'Store keeper', 'Approved by'] },
  'hrm.leave': { title: 'Leave Application', party: { field: 'employeeId', label: 'Employee' }, sections: [['Leave', ['leaveTypeId', 'from', 'to', 'days', 'reason']]], signatures: ['Employee', 'Line manager', 'HR'] },
  'hrm.payslip': { title: 'Payslip', party: { field: 'employeeId', label: 'Employee' }, sections: [['Pay', ['period', 'gross', 'deductions', 'advanceDeduction', 'net', 'paid']]], signatures: ['Employee', 'HR / Accounts'], words: true },
};

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} hundred` : '', rest].filter(Boolean).join(' ');
}

/** 1234.5, 'PKR' → "PKR one thousand two hundred thirty-four and 50/100 only". */
export function amountInWords(amount: number, currency: string): string {
  const neg = amount < 0;
  const cents = Math.round(Math.abs(amount) * 100);
  let n = Math.floor(cents / 100);
  const parts: string[] = [];
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'], [1, '']] as const) {
    const chunk = Math.floor(n / size);
    if (chunk) parts.push(`${under1000(chunk)}${name ? ` ${name}` : ''}`);
    n %= size;
  }
  const words = parts.join(' ') || 'zero';
  const frac = cents % 100;
  return `${neg ? 'minus ' : ''}${currency} ${words}${frac ? ` and ${String(frac).padStart(2, '0')}/100` : ''} only`.replace(/^./, (c) => c.toUpperCase());
}
