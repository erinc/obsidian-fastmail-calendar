import ICAL from "ical.js";
import { XMLParser } from "fast-xml-parser";

export interface FastmailCalendar {
  id: string;
  title: string;
  url: string;
  color?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  calendarId: string;
  location?: string;
}

function localDayStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Split a fetched range into local calendar days, preserving multi-day events on every overlapping day. */
export function partitionEventsByDay(
  events: CalendarEvent[],
  rangeStart: Date,
  rangeEnd: Date
): Map<string, CalendarEvent[]> {
  const days = new Map<string, CalendarEvent[]>();
  for (
    let day = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
    day < rangeEnd;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const matches = events.filter((event) => {
      const start = new Date(event.start);
      const end = new Date(event.end);
      if (+start === +end) return start >= day && start < next;
      return end > day && start < next;
    });
    matches.sort((a, b) => +new Date(a.start) - +new Date(b.start));
    days.set(localDayStamp(day), matches);
  }
  return days;
}

export interface FastmailCredentials {
  username: string;
  appPassword: string;
  serverUrl: string;
}

export interface DavResponse {
  status: number;
  text: string;
}

export type DavRequest = (options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<DavResponse>;

type XmlRecord = Record<string, any>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) {
    return String((value as XmlRecord)["#text"] ?? "");
  }
  return "";
}

function successfulProps(response: XmlRecord): XmlRecord {
  const props: XmlRecord = {};
  for (const propstat of asArray(response.propstat)) {
    if (!/\s2\d\d(?:\s|$)/.test(textValue(propstat?.status))) continue;
    Object.assign(props, propstat?.prop ?? {});
  }
  return props;
}

function parseMultistatus(xml: string): XmlRecord[] {
  let parsed: XmlRecord;
  try {
    parsed = xmlParser.parse(xml) as XmlRecord;
  } catch (error) {
    throw new Error(`Fastmail returned invalid CalDAV XML: ${String(error)}`);
  }
  const multistatus = parsed.multistatus ?? parsed;
  return asArray(multistatus.response);
}

function absoluteUrl(href: string, relativeTo: string): string {
  return new URL(href, relativeTo).toString();
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function davTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface IcalTimeLike {
  isDate: boolean;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  zone?: { tzid?: string };
  toJSDate(): Date;
}

function timeToDate(time: IcalTimeLike): Date {
  if (time.isDate || time.zone?.tzid === "floating") {
    return new Date(
      time.year,
      time.month - 1,
      time.day,
      time.isDate ? 0 : time.hour,
      time.isDate ? 0 : time.minute,
      time.isDate ? 0 : time.second
    );
  }
  return time.toJSDate();
}

function overlaps(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): boolean {
  if (+start === +end) return start >= rangeStart && start < rangeEnd;
  return end > rangeStart && start < rangeEnd;
}

function eventFromOccurrence(
  event: InstanceType<typeof ICAL.Event>,
  startTime: IcalTimeLike,
  endTime: IcalTimeLike,
  calendar: FastmailCalendar,
  suffix = ""
): CalendarEvent {
  const start = timeToDate(startTime);
  const end = timeToDate(endTime);
  return {
    id: `${event.uid || "event"}${suffix}`,
    title: event.summary || "(no title)",
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: startTime.isDate,
    calendar: calendar.title,
    calendarId: calendar.id,
    location: event.location || undefined,
  };
}

/** Parse one CalDAV calendar-data payload, including unexpanded recurrences. */
export function parseCalendarData(
  source: string,
  calendar: FastmailCalendar,
  rangeStart: Date,
  rangeEnd: Date
): CalendarEvent[] {
  if (!source.trim()) return [];
  const root = new ICAL.Component(ICAL.parse(source));
  const components = root.getAllSubcomponents("vevent");
  const recurringEvents = new Map<string, InstanceType<typeof ICAL.Event>>();
  for (const component of components) {
    if (component.hasProperty("rrule") && !component.hasProperty("recurrence-id")) {
      const event = new ICAL.Event(component);
      recurringEvents.set(event.uid, event);
    }
  }
  for (const component of components) {
    if (!component.hasProperty("recurrence-id")) continue;
    const exception = new ICAL.Event(component);
    recurringEvents.get(exception.uid)?.relateException(exception);
  }
  const events: CalendarEvent[] = [];

  for (const component of components) {
    const parsedEvent = new ICAL.Event(component);
    const event = recurringEvents.get(parsedEvent.uid) ?? parsedEvent;
    const status = textValue(component.getFirstPropertyValue("status")).toUpperCase();
    if (status === "CANCELLED") continue;

    if (parsedEvent.isRecurrenceException() && recurringEvents.has(parsedEvent.uid)) continue;
    if (!event.isRecurring()) {
      const start = timeToDate(event.startDate);
      const end = timeToDate(event.endDate);
      if (overlaps(start, end, rangeStart, rangeEnd)) {
        events.push(
          eventFromOccurrence(event, event.startDate, event.endDate, calendar, `:${start.toISOString()}`)
        );
      }
      continue;
    }

    // Event.iterator(startTime) changes the recurrence's DTSTART; it does not
    // seek to that point. Start at the real DTSTART so exception IDs still
    // match, then discard occurrences before the requested range.
    const iterator = event.iterator();
    for (let count = 0; count < 100000; count += 1) {
      const occurrence = iterator.next();
      if (!occurrence) break;
      const details = event.getOccurrenceDetails(occurrence);
      const start = timeToDate(details.startDate);
      if (start >= rangeEnd) break;
      const end = timeToDate(details.endDate);
      const itemStatus = textValue(details.item.component.getFirstPropertyValue("status")).toUpperCase();
      if (itemStatus !== "CANCELLED" && overlaps(start, end, rangeStart, rangeEnd)) {
        events.push(
          eventFromOccurrence(
            details.item,
            details.startDate,
            details.endDate,
            calendar,
            `:${start.toISOString()}`
          )
        );
      }
    }
  }
  return events;
}

export class FastmailCalDavClient {
  private readonly serverUrl: string;
  private readonly username: string;
  private readonly authorization: string;

  constructor(
    credentials: FastmailCredentials,
    private readonly request: DavRequest
  ) {
    let configuredUrl: URL;
    try {
      configuredUrl = new URL(credentials.serverUrl.trim());
    } catch {
      throw new Error("The CalDAV server must be a valid HTTPS URL.");
    }
    if (configuredUrl.protocol !== "https:") {
      throw new Error("The CalDAV server must use HTTPS to protect your app password.");
    }
    if (configuredUrl.username || configuredUrl.password) {
      throw new Error("Do not include credentials in the CalDAV server URL.");
    }
    if (configuredUrl.origin !== "https://caldav.fastmail.com") {
      throw new Error("Fastmail credentials may only be sent to https://caldav.fastmail.com/.");
    }
    this.serverUrl = configuredUrl.toString().replace(/\/*$/, "/");
    this.username = credentials.username.trim();
    this.authorization = basicAuthorization(this.username, credentials.appPassword);
  }

  private async dav(method: "PROPFIND" | "REPORT", url: string, body: string, depth: string) {
    const response = await this.request({
      url,
      method,
      body,
      headers: {
        Authorization: this.authorization,
        "Content-Type": "application/xml; charset=utf-8",
        Depth: depth,
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("Fastmail rejected the username or app password. Create a calendar-enabled app password and try again.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Fastmail CalDAV request failed (HTTP ${response.status}).`);
    }
    return response.text;
  }

  private calendarHomeUrl(): string {
    const configured = new URL(this.serverUrl);
    if (/\/dav\/calendars\/user\/[^/]+\/?$/.test(configured.pathname)) {
      configured.pathname = configured.pathname.replace(/\/*$/, "/");
      return configured.toString();
    }
    return new URL(
      `/dav/calendars/user/${encodeURIComponent(this.username)}/`,
      configured.origin
    ).toString();
  }

  async listCalendars(): Promise<FastmailCalendar[]> {
    const homeUrl = this.calendarHomeUrl();
    const xml = await this.dav(
      "PROPFIND",
      homeUrl,
      `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><d:displayname /><d:resourcetype /><cs:calendar-color /></d:prop>
</d:propfind>`,
      "1"
    );
    const calendars: FastmailCalendar[] = [];
    for (const response of parseMultistatus(xml)) {
      const props = successfulProps(response);
      if (!props.resourcetype || !("calendar" in props.resourcetype)) continue;
      const href = textValue(response.href);
      if (!href) continue;
      const url = absoluteUrl(href, homeUrl);
      const fallback = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "Calendar");
      const color = textValue(props["calendar-color"]);
      calendars.push({
        id: url,
        url,
        title: textValue(props.displayname) || fallback,
        ...(color ? { color } : {}),
      });
    }
    return calendars.sort((a, b) => a.title.localeCompare(b.title));
  }

  async fetchEvents(calendar: FastmailCalendar, rangeStart: Date, rangeEnd: Date): Promise<CalendarEvent[]> {
    const start = davTimestamp(rangeStart);
    const end = davTimestamp(rangeEnd);
    const xml = await this.dav(
      "REPORT",
      calendar.url,
      `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag /><c:calendar-data><c:expand start="${xmlEscape(start)}" end="${xmlEscape(end)}" /></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${xmlEscape(start)}" end="${xmlEscape(end)}" /></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`,
      "1"
    );
    const events: CalendarEvent[] = [];
    for (const response of parseMultistatus(xml)) {
      const calendarData = textValue(successfulProps(response)["calendar-data"]);
      if (calendarData) events.push(...parseCalendarData(calendarData, calendar, rangeStart, rangeEnd));
    }
    return events;
  }
}
