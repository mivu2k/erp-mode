'use client';
import { createContext, ReactNode, useContext, useEffect } from 'react';

/** UI chrome strings. Field/record labels come from data; unknown keys fall back to English text. */
const UR: Record<string, string> = {
  Search: 'تلاش', Filters: 'فلٹرز', Columns: 'کالم', Views: 'ویوز', Export: 'برآمد', Print: 'پرنٹ', 'Clear filters': 'فلٹر صاف کریں', Any: 'کوئی بھی', Yes: 'ہاں', No: 'نہیں',
  table: 'جدول', grid: 'گرڈ', kanban: 'کانبان', calendar: 'کیلنڈر', Prev: 'پچھلا', Next: 'اگلا', records: 'ریکارڈز', 'Nothing here yet': 'ابھی کچھ نہیں', 'Try clearing search and filters.': 'تلاش اور فلٹر صاف کریں۔',
  Dashboard: 'ڈیش بورڈ', Approvals: 'منظوریاں', New: 'نیا', Save: 'محفوظ کریں', Create: 'بنائیں', Delete: 'حذف کریں', Cancel: 'منسوخ', Confirm: 'تصدیق', Details: 'تفصیلات', Attachments: 'منسلکات', Activity: 'سرگرمی', Time: 'وقت',
  'Submit for approval': 'منظوری کے لیے بھیجیں', Approve: 'منظور', Reject: 'مسترد', 'Send back': 'واپس بھیجیں', 'Sign out': 'سائن آؤٹ', 'Search or scan…': 'تلاش یا اسکین…', Notifications: 'اطلاعات', 'Mark all read': 'سب پڑھ لیا',
  Home: 'ہوم', Scan: 'اسکین', Menu: 'مینو', 'Save current view': 'موجودہ ویو محفوظ کریں', 'Welcome': 'خوش آمدید', 'Waiting for my approval': 'میری منظوری کے منتظر', Language: 'زبان', Today: 'آج',
  Admin: 'ایڈمن', HR: 'ایچ آر', Finance: 'مالیات', Inventory: 'انوینٹری', Purchase: 'خریداری', Repair: 'مرمت', Fleet: 'گاڑیاں', Gatepass: 'گیٹ پاس', Sales: 'فروخت', Reports: 'رپورٹس',
  Rows: 'قطاریں', 'My account': 'میرا اکاؤنٹ', Modules: 'ماڈیولز', of: 'میں سے', Start: 'شروع', Stop: 'روکیں', Dashboards: 'ڈیش بورڈز', 'Add widget': 'ویجیٹ شامل کریں',
};
const DICTS: Record<string, Record<string, string>> = { en: {}, ur: UR };
const RTL = new Set(['ur', 'ar', 'fa']);

const Ctx = createContext<(s: string) => string>((s) => s);
export const useT = () => useContext(Ctx);

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const dict = DICTS[locale] ?? {};
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = RTL.has(locale) ? 'rtl' : 'ltr';
  }, [locale]);
  return <Ctx.Provider value={(s) => dict[s] ?? s}>{children}</Ctx.Provider>;
}
