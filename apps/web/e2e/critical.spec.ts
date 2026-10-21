import { expect, test } from '@playwright/test';

const run = Date.now().toString(36);

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill('admin@erp.local');
  await page.getByLabel('Password').fill('Admin@12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
});

test('create employee via generic form, find it in list, grid and global search', async ({ page }) => {
  await page.goto('/r/hrm.employee/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Sara ${run}`);
  await page.getByLabel('Phone').fill('03001234567');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: `Sara ${run}` })).toBeVisible();

  await page.goto('/r/hrm.employee');
  await page.getByLabel('Search').fill(`Sara ${run}`);
  await expect(page.getByRole('cell', { name: `Sara ${run}` })).toBeVisible();
  await page.getByRole('button', { name: 'grid' }).click();
  await expect(page.getByText(`Sara ${run}`)).toBeVisible();
  await page.getByRole('button', { name: 'table' }).click();

  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Name, number, serial/).fill(`Sara ${run}`);
  await page.getByRole('button', { name: new RegExp(`Sara ${run}.*Employees`) }).click();
  await expect(page).toHaveURL(/\/r\/hrm\.employee\/\w+/);
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText(/create/)).toBeVisible();
});

test('expense advance: submit → approve from inbox', async ({ page }) => {
  await page.goto('/r/finance.advance/new');
  await page.getByRole('combobox', { name: 'Employee' }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('75000');
  await page.getByLabel('Purpose').fill(`Trip ${run}`);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('pending', { exact: true }).first()).toBeVisible();

  await page.goto('/approvals');
  const card = page.locator('article', { hasText: `Trip ${run}` }).first();
  await card.getByRole('button', { name: 'Approve' }).click(); // 2-step workflow (≥ 50,000): one admin approval finishes it
  await page.getByRole('tab', { name: 'Decided by me' }).click();
  await expect(page.getByText(`Trip ${run}`).first()).toBeVisible();
});

test('dark mode, permission matrix and report builder render', async ({ page }) => {
  await expect(page.locator('html')).toHaveClass(/dark/); // dark by default (company branding)
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.goto('/admin/roles');
  await page.getByRole('option', { name: 'Technician' }).click();
  await page.getByLabel('Filter screens').fill('employee');
  const create = page.getByRole('button', { name: 'Employees: Create' });
  await create.click();
  await expect(page.getByText('Unsaved changes to Technician')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Employees: View' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/roles.png', fullPage: true });
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('Unsaved changes')).toBeHidden();
  await page.goto('/reports');
  await page.getByRole('tab', { name: 'Report builder' }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/rows/)).toBeVisible();
  await page.screenshot({ path: 'test-results/reports-dark.png', fullPage: true });
});

test('Urdu switches the shell to RTL and back', async ({ page }) => {
  await page.getByRole('button', { name: 'Language' }).click();
  try {
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('link', { name: 'منظوریاں' }).first()).toBeVisible();
  } finally {
    // Shared admin account: always leave it in English, even if the assertions above fail.
    await page.getByRole('button', { name: 'زبان' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  }
});

test('calendar view and dashboard builder', async ({ page }) => {
  await page.goto('/r/hrm.task');
  await page.getByRole('button', { name: 'calendar' }).click();
  await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();

  await page.goto('/dashboards');
  page.once('dialog', (d) => d.accept(`Ops ${run}`));
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByLabel('Report').selectOption({ label: 'Jobs by status' });
  await page.getByRole('button', { name: 'Add widget' }).click();
  await expect(page.getByRole('heading', { name: 'Jobs by status' })).toBeVisible();
  await expect(page.getByRole('figure', { name: 'Jobs by status' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
});

test('automation: product fills PO price; receive dialog pre-fills open lines', async ({ page }) => {
  await page.goto('/r/purchase.order/new');
  await expect(page.getByRole('textbox', { name: 'Date', exact: true }).or(page.getByLabel('Date'))).toHaveValue(new Date().toISOString().slice(0, 10));
  await page.getByRole('combobox', { name: 'Vendor' }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByRole('button', { name: '+ Add line' }).click();
  await page.getByRole('combobox', { name: /Product/ }).click();
  await page.getByRole('combobox', { name: /Product/ }).fill('Screen');
  await page.getByRole('listbox').getByRole('option').first().click();
  const price = page.locator('tbody input#price');
  await expect(price).not.toHaveValue('');
  await page.locator('tbody input#qty').fill('2');
  await expect(page.getByRole('cell', { name: /\d/ }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('approved', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Receive goods (GRN)' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('tbody input#qty')).toHaveValue('2');
  await expect(dialog.locator('tbody input#productId')).toHaveValue(/Screen/);
  await dialog.getByRole('combobox', { name: 'Warehouse' }).click();
  await dialog.getByRole('listbox').getByRole('option', { name: /Main Store/ }).click();
  await page.screenshot({ path: 'test-results/receive-dialog.png' });
  await dialog.getByRole('button', { name: 'Receive goods (GRN)' }).click();
  await expect(page.getByText('received', { exact: true }).first()).toBeVisible();
});

test('attachments: upload with progress, thumbnail, preview', async ({ page }) => {
  await page.goto('/r/hrm.employee/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Pic ${run}`);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: `Pic ${run}` })).toBeVisible();
  await page.getByRole('tab', { name: 'Attachments' }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.getByLabel('Choose files').setInputFiles([{ name: 'badge.png', mimeType: 'image/png', buffer: png }, { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('MZ not an image') }]);
  await expect(page.getByRole('button', { name: 'Preview badge.png' })).toBeVisible();
  await expect(page.getByText(/evil\.png: File type not allowed/)).toBeVisible();
  await page.getByRole('button', { name: 'Preview badge.png' }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: 'badge.png' })).toBeVisible();
  await page.screenshot({ path: 'test-results/attachments.png' });
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // Photo field on the Details tab uses the same upload.
  await page.getByRole('tab', { name: 'Details' }).click();
  await page.getByLabel('Photo').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('img', { name: 'Photo' })).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Unsaved changes')).toBeHidden();
});

test('logo upload shows in sidebar; product image gallery', async ({ page, request }) => {
  // Remember the company's real branding and put it back exactly, whatever happens in this test.
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const company = (await (await request.get('/api/r/core.company?pageSize=1', { headers: auth })).json()).rows[0];
  try {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.goto('/admin/branding');
  await page.getByLabel('Upload Logo (dark background)').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('img', { name: 'Logo (dark background)' })).toBeVisible();
  await page.getByRole('button', { name: 'Save & apply' }).click();
  await expect(page.locator('aside img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);

  await page.goto('/r/inventory.product/new'); // the generic address hands over to the product screen
  await expect(page).toHaveURL(/\/inventory\/products\/new/);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Gallery ${run}`);
  await page.getByLabel('Add barcode').fill(`ALT-${run}`);
  await page.getByLabel('Add barcode').press('Enter');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name: `Gallery ${run}` })).toBeVisible();
  await expect(page.getByText(`ALT-${run}`)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Stock' })).toBeVisible();
  await page.getByLabel('Upload Images').setInputFiles([{ name: '1.png', mimeType: 'image/png', buffer: png }, { name: '2.png', mimeType: 'image/png', buffer: png }]);
  await expect(page.getByRole('img', { name: 'Images 2' })).toBeVisible();
  await expect(page.getByText('Main', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/r\/inventory\.product\?kind=product$/);

  } finally {
    const res = await request.patch(`/api/r/core.company/${company.id}`, { headers: auth, data: { branding: company.branding } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
});

test('intake: inline validation, known serial fills in, duplicate unit, draft survives reload', async ({ page }) => {
  await page.goto('/repair/intake');
  await page.getByRole('button', { name: 'Clear form' }).click();
  await page.getByRole('button', { name: 'Receive 1 unit' }).click();
  await expect(page.getByText('Describe the reported fault')).toBeVisible();
  await expect(page.getByText('Pick the customer or unit')).toBeVisible();
  await page.getByLabel('Serial number').fill(`SN2-${run}-none`);
  await page.getByLabel('Serial number').press('Enter');
  await expect(page.getByText('First time we see this serial.')).toBeVisible();
  await page.getByLabel('Model').fill(`XR-${run}`);
  await page.getByLabel('Reported fault').fill('No transmit');
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByRole('button', { name: 'Receive 2 units' })).toBeVisible();
  await expect(page.getByLabel('Model').nth(1)).toHaveValue(`XR-${run}`);
  await page.screenshot({ path: 'test-results/intake.png', fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Receive 2 units' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear form' }).click();
});

test('assign roles to a user from the Roles tab', async ({ page }) => {
  await page.goto('/r/core.user');
  await page.getByLabel('Search').fill('Maker');
  await page.getByRole('cell', { name: /^Maker / }).first().click();
  await page.getByRole('tab', { name: 'Roles' }).click();
  const tech = page.getByRole('switch', { name: 'Technician' });
  const was = await tech.isChecked();
  await tech.setChecked(!was, { force: true });
  await page.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Roles' }).click();
  await expect(page.getByRole('switch', { name: 'Technician' })).toBeChecked({ checked: !was });
});

test('a posted record reads as a document; super admin can switch to the form', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const q = encodeURIComponent(JSON.stringify({ status: 'paid' }));
  const paid = (await (await request.get(`/api/r/finance.claim?pageSize=1&filters=${q}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json()).rows[0];
  await page.goto(`/r/finance.claim/${paid.id}`);
  await expect(page.getByText(/Read-only — (Paid|Settled)/)).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Amount' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Total' })).toBeVisible();
  await page.screenshot({ path: 'test-results/posted.png', fullPage: true });
  await page.getByRole('button', { name: 'Edit anyway' }).click();
  await expect(page.getByText(/Read-only —/)).toBeHidden();
  await page.getByRole('button', { name: 'Done editing' }).click();
});

test('invoice lines read as a table, not JSON', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const inv = (await (await request.get('/api/r/repair.invoice?pageSize=1&sort=createdAt:desc', { headers: { Authorization: `Bearer ${accessToken}` } })).json()).rows[0];
  await page.goto(`/r/repair.invoice/${inv.id}`);
  await expect(page.getByText(/Read-only —/)).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Price' })).toBeVisible();
  await expect(page.getByText('"qty"')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/invoice.png', fullPage: true });
  await page.getByRole('button', { name: 'Edit anyway' }).click();
  await expect(page.getByLabel('Journal')).toHaveCount(0);
});

test('P&R: forecast, aging, by party, and a part payment straight from the timeline', async ({ page, request }) => {
  // Its own receivable, due yesterday (the small Overdue group), so repeated runs never whittle a shared item down to cents.
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const acc = (await (await request.get(`/api/r/finance.account?pageSize=1&filters=${encodeURIComponent(JSON.stringify({ code: '4100' }))}`, { headers: auth })).json()).rows[0];
  await request.post('/api/r/payables.due', { headers: auth, data: { direction: 'receivable', partyName: `PR ${run}`, description: `PR test ${run}`, amount: '1000', dueDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), accountId: acc.id } });
  await page.goto('/payables');
  await expect(page.getByText('Cash-flow forecast — next 8 weeks')).toBeVisible();
  await expect(page.getByText('Cash & bank now')).toBeVisible();
  await page.getByRole('tab', { name: 'Aging' }).click();
  await expect(page.getByRole('columnheader', { name: '90+ days' })).toBeVisible();
  await page.getByRole('tab', { name: 'By party' }).click();
  await expect(page.getByText('Who owes us')).toBeVisible();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await page.screenshot({ path: 'test-results/pr.png' });
  // Overdue shows 8 items until expanded; earlier runs may have left more.
  const more = page.getByRole('button', { name: /^Show all/ }).first();
  if (await more.isVisible()) await more.click();
  const item = page.locator('li').filter({ hasText: `PR ${run}` }).first();
  await item.getByRole('button', { name: 'Receive' }).click();
  await page.getByRole('button', { name: 'Half' }).click();
  await expect(page.getByText(/Part payment — .* stays open/)).toBeVisible();
  await page.getByRole('button', { name: /Record (receipt|payment)/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('utilities tracker renders with the month strip', async ({ page }) => {
  await page.goto('/utilities');
  await expect(page.getByRole('heading', { name: 'Utilities' })).toBeVisible();
  await expect(page.getByText('Bills not received')).toBeVisible();
  await page.screenshot({ path: 'test-results/utilities.png' });
});

test('kiosk pairing by link: admin gets link + QR, opening it pairs the device', async ({ page, browser, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const st = await (await request.post('/api/r/hrm.station', { headers: { Authorization: `Bearer ${accessToken}` }, data: { name: `Gate ${run}` } })).json();
  await page.goto(`/r/hrm.station/${st.id}`);
  await page.getByRole('button', { name: 'Pair a device (link / QR)' }).click();
  const link = await page.getByLabel('Pairing link').inputValue();
  expect(link).toMatch(/\/kiosk\?code=\d{6}$/);
  await expect(page.locator('dialog[open] svg').first()).toBeVisible();
  const ctx = await browser.newContext();
  const kiosk = await ctx.newPage();
  await kiosk.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(kiosk.getByText(`Gate ${run}`)).toBeVisible();
  expect(kiosk.url()).not.toContain('code=');
  await expect(kiosk.getByText('Online')).toBeVisible();
  await expect(kiosk.getByRole('button', { name: /unpair/i })).toHaveCount(0); // staff can't unpair the kiosk
  // Only an admin can unpair; the kiosk notices on its next request and goes back to pairing.
  await page.reload(); // closes the pairing dialog
  page.once('dialog', (d) => d.accept()); // "Unpair the device at this station?"
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/unpair') && r.ok()), page.getByRole('button', { name: 'Unpair device' }).click()]);
  await kiosk.getByLabel('Card reader input').fill('ANY-CARD');
  await kiosk.getByLabel('Card reader input').press('Enter');
  await expect(kiosk.getByText('This kiosk was unpaired by an administrator')).toBeVisible();
  await ctx.close(); // the paired kiosk page must not outlive this test
});

test('salary structure: employee name as title, components as an editable table', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const s = (await (await request.get('/api/r/hrm.salary?pageSize=1&sort=createdAt:desc', { headers: auth })).json()).rows[0];
  await page.goto(`/r/hrm.salary/${s.id}`);
  await expect(page.getByRole('heading', { name: s._refs.employeeId })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Component' })).toBeVisible();
  await expect(page.getByText('"mode"')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/salary.png' });
});

test('sidebar splits a module into Employee and Management & admin', async ({ page }) => {
  await page.getByRole('button', { name: 'HR' }).click();
  const nav = page.locator('aside').first();
  await expect(nav.getByText('Employee', { exact: true })).toBeVisible();
  await expect(nav.getByText('Management & admin')).toBeVisible();
  await page.screenshot({ path: 'test-results/sidebar.png' });
});

test('My HR page shows my own profile, leave, pay and requests', async ({ page }) => {
  await page.getByRole('link', { name: 'My HR' }).click();
  await expect(page.getByRole('heading', { name: /^My HR/ })).toBeVisible();
  await expect(page.getByText('Paid leave remaining')).toBeVisible();
  await expect(page.getByText('Payslips', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/me.png', fullPage: true });
  await page.getByRole('button', { name: 'Check in at a kiosk' }).click();
  await expect(page.getByRole('button', { name: 'Scan from a photo' })).toBeVisible(); // the scanner is open
});

test('guided expense claim: New goes to the claim form, live total, save draft', async ({ page }) => {
  await page.goto('/r/finance.claim');
  await page.getByRole('link', { name: 'New' }).click();
  await expect(page).toHaveURL(/\/finance\/claims\/new/);
  await expect(page.getByRole('radio', { name: /Reimburse me/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Type').first().selectOption({ index: 1 });
  await page.getByLabel('Amount').first().fill('1200');
  await page.getByLabel('Description').first().fill(`Taxi ${run}`);
  await page.getByRole('button', { name: '+ Add expense' }).click();
  await page.getByLabel('Type').nth(1).selectOption({ index: 1 });
  await page.getByLabel('Amount').nth(1).fill('300');
  await expect(page.getByText('Total claimed')).toBeVisible();
  await expect(page.locator('dd', { hasText: '1,500' }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/claim-new.png', fullPage: true });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/r\/finance\.claim\/\w+/);
  await expect(page.getByText('1,500').first()).toBeVisible();
});

test('record utility bill: grouped form with live total from the server', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const conn = (await (await request.get('/api/r/utilities.connection?pageSize=1&sort=createdAt:desc', { headers: { Authorization: `Bearer ${accessToken}` } })).json()).rows[0];
  test.skip(!conn, 'no utility connection yet');
  await page.goto(`/r/utilities.connection/${conn.id}`);
  await page.getByRole('button', { name: 'Record bill' }).click();
  await expect(page.getByText('Bill total')).toBeVisible();
  await page.getByLabel('Usage charge').fill('1000');
  await page.getByLabel('Tax').fill('170');
  await expect(page.locator('dialog[open] dd', { hasText: /^1,[0-9]{3}/ }).last()).toBeVisible();
  await page.screenshot({ path: 'test-results/bill-dialog.png' });
});

test('rich-text editor on catalog item: toolbar, bold, saved and shown formatted', async ({ page }) => {
  await page.goto('/r/catalog.item/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Rich ${run}`);
  const ed = page.locator('#summary');
  await expect(page.getByRole('toolbar', { name: 'Formatting' }).first()).toBeVisible();
  await ed.click();
  await page.getByRole('button', { name: 'Bold' }).first().click();
  await page.keyboard.type('Rugged');
  await page.getByRole('button', { name: 'Bold' }).first().click();
  await page.keyboard.type(' and light');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: `Rich ${run}` })).toBeVisible();
  await expect(page.locator('#summary b, #summary strong').first()).toHaveText('Rugged');
  await page.screenshot({ path: 'test-results/richtext.png' });
});

test('standard reports: library by module, period presets, table with totals, export', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByRole('navigation', { name: 'Standard reports' })).toBeVisible();
  await page.getByRole('button', { name: 'Invoiced by customer' }).click();
  await page.getByRole('button', { name: 'This year' }).click();
  await expect(page.getByRole('columnheader', { name: 'Balance' })).toBeVisible();
  await expect(page.locator('tfoot').getByText('Total')).toBeVisible();
  await page.screenshot({ path: 'test-results/standard-reports.png', fullPage: true });
});

test('serial tracking: register in a dialog, open the unit, issue it, see it on the timeline', async ({ page }) => {
  const sn = `UI-SN-${run}`;
  await page.goto('/serials');
  await page.getByRole('button', { name: 'Register serials' }).click();
  await page.getByLabel('Serial numbers to register').fill(`${sn} | IMEI2-${run}`);
  await page.getByRole('dialog').getByRole('button', { name: /^Register 1/ }).click();
  await expect(page.getByText('1 registered.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('Scan or search').fill(sn);
  await page.getByLabel('Scan or search').press('Enter');
  const panel = page.getByRole('complementary', { name: 'Unit details' });
  await expect(panel.getByText(sn)).toBeVisible();
  await expect(panel.getByText(`IMEI2-${run}`)).toBeVisible(); // its other code
  await panel.getByRole('button', { name: 'Issue to…' }).click();
  await panel.getByRole('textbox').first().fill('Field team 7');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByText('Issued', { exact: true })).toBeVisible();
  await expect(panel.getByText(/by Super Admin/).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/serials.png', fullPage: true });
});

test('search: scanning a barcode from a photo opens the record (no built-in reader, no HTTPS needed)', async ({ page, request, browser }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const job = (await (await request.get('/api/r/repair.job?pageSize=1', { headers: auth })).json()).rows[0];
  // "Photograph" the job's printed QR label: render it large and screenshot it as a PNG.
  const label = (await (await request.get(`/api/print/repair.job/${job.id}?template=label`, { headers: auth })).text()).replace(/<script[\s\S]*?<\/script>/g, '');
  const cam = await browser.newPage();
  await cam.setContent(label.replace('</style>', 'svg{width:400px!important;height:400px!important}.l{width:auto!important;height:auto!important;overflow:visible!important}body{padding:40px;background:#fff}</style>'));
  const png = await cam.locator('svg').first().screenshot();
  await cam.close();

  await page.goto('/');
  await page.getByRole('button', { name: /Search or scan/ }).click();
  await page.locator('input[type=file][capture]').setInputFiles({ name: 'code.png', mimeType: 'image/png', buffer: png });
  await expect(page).toHaveURL(new RegExp(`/r/repair.job/${job.id}`), { timeout: 15_000 });
});

test('intake: a known serial fills make, model, type and the owner', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Owner ${run}` } })).json();
  await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productType: 'Handheld radio', brand: 'Hytera', model: `PD-${run}`, serial: `KN-${run}`, fault: 'No power' }] } });
  await page.goto('/repair/intake');
  await page.getByRole('button', { name: 'Clear form' }).click();
  await page.getByLabel('Serial number').fill(`KN-${run}`);
  await page.getByLabel('Serial number').press('Enter');
  await expect(page.getByText(/Known unit/)).toBeVisible();
  await expect(page.getByLabel('Make')).toHaveValue('Hytera');
  await expect(page.getByLabel('Model')).toHaveValue(`PD-${run}`);
  await expect(page.getByLabel('Equipment type')).toHaveValue('Handheld radio');
  await expect(page.getByText(`owner: Owner ${run}`)).toBeVisible();
  await page.getByRole('button', { name: 'Clear form' }).click();
});

test('search: an unknown barcode offers to create the product with it', async ({ page }) => {
  const code = `NEW-${run}`;
  await page.goto('/');
  await page.getByRole('button', { name: /Search or scan/ }).click();
  const box = page.getByPlaceholder(/Name, number, serial/);
  await box.fill(code);
  await box.press('Enter');
  await page.getByRole('button', { name: `Create product with barcode ${code}` }).click();
  await expect(page).toHaveURL(/\/inventory\/products\/new/);
  await expect(page.getByRole('button', { name: `Remove ${code}` })).toBeVisible(); // the scanned code is on the new item
});

test('new product: typing the name fills the brand; the SKU is made on save', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  await request.post('/api/r/inventory.product', { headers: { Authorization: `Bearer ${accessToken}` }, data: { sku: `ZK-${run}`, name: 'seed', brand: `Zeko${run}`, price: '1' } });
  await page.goto('/inventory/products/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Zeko${run} handheld radio`);
  await expect(page.getByRole('combobox', { name: 'Brand', exact: true })).toHaveValue(`Zeko${run}`);
  await expect(page.getByText('the SKU is made when you save')).toBeVisible();
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name: `Zeko${run} handheld radio` })).toBeVisible();
  await expect(page.getByText(/^ZEK-HANDHELD-[2-9A-HJ-NP-Z]{4}$/)).toBeVisible(); // SKU in the header
});

test('product: label dialog for all its barcodes; repair history from intake', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const p = await (await request.post('/api/r/inventory.product', { headers: auth, data: { sku: `LBL-${run}`, name: `Meter ${run}`, brand: 'Fluke', model: `M-${run}`, price: '5', barcode: `L1-${run}`, barcodes: `L2-${run}` } })).json();
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Lab ${run}` } })).json();
  const { jobs } = await (await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productId: p.id, brand: 'Fluke', model: `M-${run}`, fault: 'No display' }] } })).json();
  await page.goto(`/inventory/products/${p.id}`);
  await expect(page.getByRole('link', { name: jobs[0].number })).toBeVisible(); // repair history
  await page.getByRole('button', { name: 'Print labels' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText(`L2-${run}`)).toBeVisible();
  await dlg.getByLabel('Copies of each').fill('3');
  await expect(dlg.getByRole('button', { name: 'Print 6 labels' })).toBeVisible();
  await dlg.getByRole('checkbox').first().uncheck();
  await expect(dlg.getByRole('button', { name: 'Print 3 labels' })).toBeVisible();
});

test('spare parts: own menu and list; New starts a spare part', async ({ page }) => {
  await page.goto('/r/inventory.product?kind=part');
  await expect(page.getByRole('heading', { name: 'Spare parts' })).toBeVisible();
  await page.getByRole('link', { name: 'New' }).click();
  await expect(page).toHaveURL(/\/inventory\/products\/new\?kind=part/);
  await expect(page.getByRole('heading', { name: 'New spare part' })).toBeVisible();
  await expect(page.getByText('Inventory › Spare parts')).toBeVisible();
});

test('products: import a CSV — preview, generated SKUs, then import', async ({ page }) => {
  const csv = `Name,Type,Brand,Model,Price\nImport radio ${run},Product,Kenwood,NX${run},1000\nImport battery ${run},Part,,,250\n,,,,\n`;
  await page.goto('/r/inventory.product?kind=product');
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByLabel('Import file').setInputFiles({ name: 'items.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('Ready:')).toBeVisible();
  await expect(page.getByRole('dialog').getByText(`Import battery ${run}`)).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('Imported:')).toBeVisible();
});

test('product: serial units with all their codes; in-stock filter; Track opens the unit', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const p = await (await request.post('/api/r/inventory.product', { headers: auth, data: { name: `Handset ${run}`, brand: 'Hytera', serialized: true, price: '1' } })).json();
  await request.post('/api/serials/register', { headers: auth, data: { serials: [`H1-${run}`, `H2-${run}`], productId: p.id, codes: { [`H1-${run}`]: [`IMEI-H-${run}`] } } });
  await page.goto(`/inventory/products/${p.id}`);
  await expect(page.getByText(`IMEI-H-${run}`)).toBeVisible();
  await expect(page.getByText(`H2-${run}`)).toBeVisible();
  await page.getByRole('button', { name: 'In stock' }).click();
  await expect(page.getByText(`H2-${run}`)).toBeVisible();
  await page.getByRole('row', { name: new RegExp(`H1-${run}`) }).getByRole('link', { name: 'Track' }).click();
  await expect(page).toHaveURL(/\/serials\?q=/);
  await expect(page.getByRole('complementary', { name: 'Unit details' }).getByText(`H1-${run}`).first()).toBeVisible();
});

test('repair job page: workflow stepper and next step', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Flow ${run}` } })).json();
  const intake = await (await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productType: 'Handheld radio', brand: 'Hytera', model: 'PD785', fault: 'No power' }] } })).json();
  const job = (await (await request.get(`/api/r/repair.job?pageSize=1&filters=${encodeURIComponent(JSON.stringify({ customerId: cust.id }))}`, { headers: auth })).json()).rows[0];
  expect(job, JSON.stringify(intake)).toBeTruthy();
  await page.goto(`/r/repair.job/${job.id}`);
  await expect(page.getByRole('list', { name: 'Repair progress' })).toBeVisible();
  await expect(page.locator('[aria-current=step]')).toContainText('Received');
  await expect(page.getByText('Next step')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit details' })).toBeVisible();
  await page.screenshot({ path: 'test-results/job-flow.png', fullPage: true });
});

test('repair job: Issue parts in the next step opens the issue form', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Parts ${run}` } })).json();
  const { jobs } = await (await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productType: 'Handheld radio', fault: 'No audio' }] } })).json();
  const part = await (await request.post('/api/r/inventory.product', { headers: auth, data: { name: `Speaker ${run}`, kind: 'part', price: '500' } })).json();
  const d = await (await request.post(`/api/repair/jobs/${jobs[0].id}/diagnose`, { headers: auth, data: { findings: 'Speaker torn', parts: [{ productId: part.id, qty: 1 }] } })).json();
  await request.post(`/api/repair/quotations/${d.quotation.id}/decision`, { headers: auth, data: { accepted: true, via: 'phone' } });
  await page.goto(`/r/repair.job/${jobs[0].id}`);
  await page.getByRole('button', { name: 'Issue parts' }).first().click();
  await expect(page.getByText('Issue parts to this job')).toBeVisible();
});

test('parts desk: the store issues what the technician requested', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Desk ${run}` } })).json();
  const { jobs } = await (await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productType: 'Handheld radio', fault: 'No audio' }] } })).json();
  const part = await (await request.post('/api/r/inventory.product', { headers: auth, data: { name: `Knob ${run}`, kind: 'part', price: '50' } })).json();
  const d = await (await request.post(`/api/repair/jobs/${jobs[0].id}/diagnose`, { headers: auth, data: { findings: 'Knob broken', parts: [{ productId: part.id, qty: 1 }] } })).json();
  await request.post(`/api/repair/quotations/${d.quotation.id}/decision`, { headers: auth, data: { accepted: true, via: 'phone' } });
  expect((await request.post(`/api/repair/jobs/${jobs[0].id}/request-parts`, { headers: auth, data: {} })).ok()).toBeTruthy();
  await page.goto('/inventory/parts-desk');
  const card = page.locator('section', { hasText: jobs[0].number });
  await expect(card).toContainText(`Knob ${run}`);
  await page.screenshot({ path: 'test-results/parts-desk.png', fullPage: true });
});

test('pending quotation: approve on the page, then the customer decision is offered', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Appr ${run}` } })).json();
  const { jobs } = await (await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productType: 'Handheld radio', fault: 'No TX' }] } })).json();
  const part = await (await request.post('/api/r/inventory.product', { headers: auth, data: { name: `TX board ${run}`, kind: 'part', price: '125' } })).json();
  const d = await (await request.post(`/api/repair/jobs/${jobs[0].id}/diagnose`, { headers: auth, data: { findings: 'TX board', parts: [{ productId: part.id, qty: 1 }] } })).json();
  expect((await request.post(`/api/r/repair.quotation/${d.quotation.id}/submit`, { headers: auth })).ok()).toBeTruthy();
  await page.goto(`/r/repair.quotation/${d.quotation.id}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Customer decision' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
});

test('saved intake: Print button with A4, A5 and POS slip', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Reprint ${run}` } })).json();
  const { intake } = await (await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productType: 'Handheld radio', fault: 'No power' }] } })).json();
  await page.goto(`/r/repair.intake/${intake.id}`);
  await page.locator('summary', { hasText: 'Print' }).click();
  await expect(page.getByRole('button', { name: 'POS receipt (80mm)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print (A5)' })).toBeVisible();
});

test('saved report opens as a report: results, role names, plain email settings', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const rep = await (await request.post('/api/r/reports.report', { headers: auth, data: { name: `Jobs ${run}`, definition: { resource: 'repair.job', columns: [], groupBy: ['status'], aggregates: [], filters: {} } } })).json();
  await page.goto(`/r/reports.report/${rep.id}`);
  await expect(page).toHaveURL(new RegExp(`/reports/saved/${rep.id}`));
  await expect(page.getByRole('heading', { name: `Jobs ${run}` })).toBeVisible();
  await expect(page.getByText(/\d+ rows/)).toBeVisible();
  await page.getByLabel('Technician').check();
  await page.getByLabel('Email it').selectOption('weekly');
  await page.getByLabel('To (emails)').fill('boss@example.com');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  const after = await (await request.get(`/api/r/reports.report/${rep.id}`, { headers: auth })).json();
  expect(after.schedule).toBe('weekly');
  expect(after.recipients).toEqual(['boss@example.com']);
  expect(after.sharedRoles).toHaveLength(1);
});

test('saved reports: New opens the report builder, not a JSON form', async ({ page }) => {
  await page.goto('/r/reports.report');
  await page.getByRole('link', { name: 'New' }).click();
  await expect(page).toHaveURL(/\/reports\?tab=builder/);
  await expect(page.getByRole('heading', { name: 'Report builder' })).toBeVisible();
});

test('report builder in plain steps: show, split by, condition, date range, save', async ({ page }) => {
  await page.goto('/reports?tab=builder');
  await page.getByLabel('1. Show me').selectOption({ label: 'Jobs' });
  await page.getByLabel('2. Split by').selectOption({ label: 'Technician' });
  await page.getByRole('button', { name: '+ Add condition' }).click();
  await page.getByLabel('Field').selectOption({ label: 'Status' });
  await page.getByLabel('Status is').selectOption('received');
  await page.getByLabel('From').fill('2026-01-01');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByText(/\d+ rows/)).toBeVisible();
  await expect(page.getByText('Filters (JSON')).toHaveCount(0);
  page.once('dialog', (d) => d.accept(`Received by tech ${run}`));
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/reports\/saved\//);
  await expect(page.getByRole('heading', { name: `Received by tech ${run}` })).toBeVisible();
  await page.screenshot({ path: 'test-results/report-builder.png', fullPage: true });
});

test('intake units: print buttons on each row', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cust = await (await request.post('/api/r/sales.customer', { headers: auth, data: { name: `Rows ${run}` } })).json();
  const { intake } = await (await request.post('/api/repair/intakes', { headers: auth, data: { customerId: cust.id, items: [{ productType: 'Handheld radio', fault: 'A' }, { productType: 'Handheld radio', fault: 'B' }] } })).json();
  await page.goto(`/r/repair.intake/${intake.id}`);
  await expect(page.getByRole('button', { name: 'Unit tag' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Slip 80mm' })).toHaveCount(2);
});

test('master data as lists: pick a list, add with Enter, switch off', async ({ page }) => {
  await page.goto('/r/core.masterdata');
  await expect(page).toHaveURL(/\/admin\/lists/);
  await page.getByRole('button', { name: /^Accessory/ }).click();
  await page.getByLabel('Add to Accessory').fill(`Belt clip ${run}`);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(`Name of Belt clip ${run}`)).toBeVisible();
  await page.getByLabel(`Name of Belt clip ${run}`).locator('xpath=..').getByLabel('In use').uncheck();
  await expect(page.getByLabel(`Name of Belt clip ${run}`)).toHaveClass(/line-through/);
  await page.screenshot({ path: 'test-results/lists.png', fullPage: true });
});

test('serial register: New opens the register dialog on the tracker', async ({ page }) => {
  await page.goto('/r/serials.item/new');
  await expect(page).toHaveURL(/\/serials\?register=1/);
  await expect(page.getByText('Scan or paste serial numbers', { exact: false }).or(page.getByPlaceholder(/Scan or paste serial numbers/))).toBeVisible();
});

test('settings as a form: account pickers, numbers, no JSON', async ({ page }) => {
  await page.goto('/admin/settings');
  await expect(page.getByText('Accounts used by automatic postings')).toBeVisible();
  await expect(page.locator('textarea.font-mono')).toHaveCount(0);
  const kiosk = page.locator('section', { hasText: 'Attendance kiosk' });
  await kiosk.getByLabel('Rotating qr seconds').fill('30');
  await kiosk.getByRole('button', { name: 'Save' }).click();
  await expect(kiosk.getByRole('status')).toHaveText('Saved');
});

test('workflow editor: document, amount rule, role step — no JSON', async ({ page, request }) => {
  await page.goto('/r/core.workflow');
  await page.getByRole('link', { name: 'New' }).click();
  await expect(page).toHaveURL(/\/admin\/workflows\/new/);
  await page.getByLabel('Name', { exact: true }).fill(`Big POs ${run}`);
  await page.getByLabel('Document').selectOption({ label: 'Purchase Orders' });
  await page.getByLabel('Only when amount is at least').fill('500000');
  await page.getByLabel('Step 1 name').fill('Director');
  await page.getByLabel('Who approves').selectOption('role');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/admin\/workflows\/(?!new)/);
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const id = page.url().split('/').pop();
  const wf = await (await request.get(`/api/r/core.workflow/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
  expect(wf.resource).toBe('purchase.order');
  expect(wf.conditions).toEqual({ minAmount: 500000 });
  expect(wf.steps[0]).toMatchObject({ name: 'Director', approverType: 'role' });
  await request.delete(`/api/r/core.workflow/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
});

test('print layout editor: pick document, insert field', async ({ page }) => {
  await page.goto('/r/core.template');
  await page.getByRole('link', { name: 'New' }).click();
  await expect(page).toHaveURL(/\/admin\/templates\/new/);
  await page.getByLabel('Document').selectOption({ label: 'Jobs' });
  await page.getByRole('button', { name: 'Fault' }).click();
  await expect(page.getByLabel('Layout (HTML)')).toHaveValue(/\{\{fault\}\}/);
});

test('attendance day: admin can delete it', async ({ page, request }) => {
  const { accessToken } = await (await request.post('/api/auth/login', { data: { login: 'admin@erp.local', password: 'Admin@12345' } })).json();
  const day = (await (await request.get('/api/r/hrm.attendance?pageSize=1', { headers: { Authorization: `Bearer ${accessToken}` } })).json()).rows[0];
  await page.goto(`/r/hrm.attendance/${day.id}`);
  await page.locator('summary', { hasText: 'More' }).click();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
});
