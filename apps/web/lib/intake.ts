export type Item = Record<string, unknown> & { accessories?: string[]; photos?: { file: File; url: string }[] };

/** Problems that block submit, keyed by field ("customer", "fault0"…). */
export function intakeProblems(customerId: unknown, items: Item[]): Record<string, string> {
  const p: Record<string, string> = {};
  if (!customerId) p.customer = 'Pick the customer or unit handing the equipment in';
  items.forEach((it, i) => {
    if (!String(it.fault ?? '').trim()) p[`fault${i}`] = 'Describe the reported fault';
    const s = String(it.serial ?? '').trim();
    if (s && items.findIndex((x) => String(x.serial ?? '').trim() === s) !== i) p[`serial${i}`] = 'Same serial entered twice';
  });
  return p;
}
