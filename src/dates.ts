/** Pure date helpers (no Obsidian dependency, unit-testable). */

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Stable per-day id, also the cache key. */
export function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Extract a date from a note basename. Accepts either positional
 * (year, month, day) groups or named (?<y>...)(?<m>...)(?<d>...) groups,
 * so derived matchers work regardless of component order (e.g. DD-MM-YYYY).
 */
export function parseDateFromBasename(name: string, pattern: string): Date | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  const m = re.exec(name);
  if (!m) return null;
  let y: number;
  let mo: number;
  let d: number;
  if (m.groups?.y !== undefined && m.groups?.m !== undefined && m.groups?.d !== undefined) {
    y = Number(m.groups.y);
    mo = Number(m.groups.m);
    d = Number(m.groups.d);
  } else {
    if (m.length < 4) return null;
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  }
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return startOfDay(dt);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MOMENT_TOKENS: Record<string, { group: "y" | "m" | "d"; regex: string }> = {
  YYYY: { group: "y", regex: "\\d{4}" },
  YY: { group: "y", regex: "\\d{2}" },
  MM: { group: "m", regex: "\\d{2}" },
  M: { group: "m", regex: "\\d{1,2}" },
  DD: { group: "d", regex: "\\d{2}" },
  D: { group: "d", regex: "\\d{1,2}" },
};

/**
 * Convert a Daily Notes moment-style format to a named-group regex.
 * Returns null for formats we can't match reliably (month/weekday names,
 * times, duplicate components, missing y/m/d).
 */
export function momentFormatToRegex(format: string): string | null {
  let out = "";
  const used = new Set<string>();
  let i = 0;
  while (i < format.length) {
    const ch = format[i];
    if (ch === "[") {
      // Moment literal escape: [...] matches literally.
      const end = format.indexOf("]", i);
      if (end === -1) return null;
      out += escapeRegExp(format.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let matched = false;
    for (const tok of ["YYYY", "YY", "MM", "DD", "M", "D"]) {
      if (format.startsWith(tok, i)) {
        const { group, regex } = MOMENT_TOKENS[tok];
        if (used.has(group)) return null;
        used.add(group);
        out += `(?<${group}>${regex})`;
        i += tok.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (/[A-Za-z]/.test(ch)) return null;
    out += escapeRegExp(ch);
    i += 1;
  }
  if (!used.has("y") || !used.has("m") || !used.has("d")) return null;
  return `^${out}$`;
}

export function prettyDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function period(d: Date): string {
  return d.getHours() < 12 ? "AM" : "PM";
}

/** "6 PM", "6:30 PM" — drops :00 to save width. */
export function compactTime(d: Date): string {
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  return `${h}${m ? `:${pad(m)}` : ""} ${period(d)}`;
}

/** "6–9 PM", "6–9:30 PM", "11 AM–1 PM". */
export function compactTimeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const end = compactTime(e);
  if (period(s) === period(e)) {
    const start = compactTime(s).replace(/ [AP]M$/, "");
    return `${start}–${end}`;
  }
  return `${compactTime(s)}–${end}`;
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 4" — fixed English abbreviations so output (and tests) don't depend on locale. */
export function shortDate(d: Date): string {
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * One-line range for the event row ("" when there is nothing worth saying,
 * i.e. single-day all-day events — the row then shows just the calendar):
 * - single timed day: "6–9 PM" ("6 PM" when zero-duration)
 * - multi-day (timed or all-day): "Sep 4 – Sep 7"
 *   (all-day end dates are exclusive, so those shift back one day)
 */
export function formatRange(startIso: string, endIso: string, allDay: boolean): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const sameDay =
    s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() && s.getDate() === e.getDate();
  if (sameDay) {
    if (allDay) return "";
    if (+s === +e) return compactTime(s);
    return compactTimeRange(startIso, endIso);
  }
  if (allDay) {
    const last = new Date(e.getFullYear(), e.getMonth(), e.getDate() - 1);
    if (dayStamp(last) <= dayStamp(s)) return "";
    return `${shortDate(s)} – ${shortDate(last)}`;
  }
  return `${shortDate(s)} – ${shortDate(e)}`;
}
