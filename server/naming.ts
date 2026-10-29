const DATE_PATTERNS = [/(\d{4})-(\d{2})-(\d{2})/, /(\d{2})-(\d{2})-(\d{2})/];

/**
 * Old-time-radio uploads put the broadcast date in the file name, e.g. `XMinusOne55-04-24001NoContact`
 * or `Dimension_X_1950-04-08__01_OuterLimit`. Returns an ISO date, or null when none is found.
 */
export function dateFromName(name: string): string | null {
  const m = DATE_PATTERNS.map((p) => p.exec(name)).find(Boolean);
  if (!m) return null;
  let year = Number(m[1]);
  if (m[1]!.length === 2) year += year >= 30 ? 1900 : 2000;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > new Date().getFullYear() || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Turns a file name into a readable title: `XMinusOne55-04-24001NoContact.mp3` becomes
 * `X Minus One 001 No Contact`. The date is dropped because it is stored separately.
 */
export function titleFromName(file: string): string {
  let name = file.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (dateFromName(name)) {
    for (const p of DATE_PATTERNS) {
      if (p.test(name)) {
        name = name.replace(p, ' ');
        break;
      }
    }
  }
  return name
    .replace(/_+/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}
