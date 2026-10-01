/** Wall-clock parts of an instant in a given IANA timezone. */
export function localParts(d: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday };
}

/** 'YYYY-MM-DD' -> Date at UTC midnight (how Prisma stores @db.Date). */
export const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const today = (tz: string) => dateOnly(localParts(new Date(), tz).date);
