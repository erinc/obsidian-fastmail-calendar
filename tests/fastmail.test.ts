import assert from "node:assert/strict";
import test from "node:test";
import {
  CalendarEvent,
  FastmailCalDavClient,
  FastmailCalendar,
  parseCalendarData,
  partitionEventsByDay,
} from "../src/fastmail";

const calendar: FastmailCalendar = {
  id: "https://caldav.fastmail.com/dav/calendars/user/test@example.com/main/",
  title: "Personal",
  url: "https://caldav.fastmail.com/dav/calendars/user/test@example.com/main/",
};

test("parses timed and all-day events", () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:timed-1\r
DTSTART:20260922T020000Z\r
DTEND:20260922T030000Z\r
SUMMARY:Team sync\r
LOCATION:Online\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:all-day-1\r
DTSTART;VALUE=DATE:20260922\r
DTEND;VALUE=DATE:20260923\r
SUMMARY:Holiday\r
END:VEVENT\r
END:VCALENDAR\r
`;
  const events = parseCalendarData(
    source,
    calendar,
    new Date("2026-09-22T00:00:00Z"),
    new Date("2026-09-23T00:00:00Z")
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].calendar, "Personal");
  assert.equal(events.find((event) => event.id.startsWith("timed-1"))?.location, "Online");
  assert.equal(events.find((event) => event.id.startsWith("all-day-1"))?.allDay, true);
});

test("expands recurring events and applies exceptions", () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:daily-1\r
DTSTART:20260920T090000Z\r
DTEND:20260920T100000Z\r
RRULE:FREQ=DAILY;COUNT=4\r
SUMMARY:Daily standup\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:daily-1\r
RECURRENCE-ID:20260922T090000Z\r
DTSTART:20260922T110000Z\r
DTEND:20260922T120000Z\r
SUMMARY:Moved standup\r
END:VEVENT\r
END:VCALENDAR\r
`;
  const events = parseCalendarData(
    source,
    calendar,
    new Date("2026-09-22T00:00:00Z"),
    new Date("2026-09-23T00:00:00Z")
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Moved standup");
  assert.equal(events[0].start, "2026-09-22T11:00:00.000Z");
});

test("discovers Fastmail calendars over CalDAV", async () => {
  let requestedUrl = "";
  const client = new FastmailCalDavClient(
    { username: "test@example.com", appPassword: "secret", serverUrl: "https://caldav.fastmail.com/" },
    async (request) => {
      requestedUrl = request.url;
      return {
        status: 207,
        text: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/user/test@example.com/main/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      };
    }
  );
  const calendars = await client.listCalendars();
  assert.equal(requestedUrl, "https://caldav.fastmail.com/dav/calendars/user/test%40example.com/");
  assert.deepEqual(calendars, [calendar]);
});

test("rejects insecure or credential-bearing CalDAV URLs", () => {
  const request = async () => ({ status: 500, text: "" });
  assert.throws(
    () =>
      new FastmailCalDavClient(
        { username: "test@example.com", appPassword: "secret", serverUrl: "http://caldav.fastmail.com/" },
        request
      ),
    /must use HTTPS/
  );
  assert.throws(
    () =>
      new FastmailCalDavClient(
        { username: "test@example.com", appPassword: "secret", serverUrl: "https://user:pass@example.com/" },
        request
      ),
    /Do not include credentials/
  );
  assert.throws(
    () =>
      new FastmailCalDavClient(
        { username: "test@example.com", appPassword: "secret", serverUrl: "https://example.com/" },
        request
      ),
    /only be sent to/
  );
});

test("queries a calendar for an expanded day range", async () => {
  let reportBody = "";
  const client = new FastmailCalDavClient(
    { username: "test@example.com", appPassword: "secret", serverUrl: "https://caldav.fastmail.com/" },
    async (request) => {
      reportBody = request.body;
      return {
        status: 207,
        text: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/event.ics</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:fetched-1
DTSTART:20260922T090000Z
DTEND:20260922T100000Z
SUMMARY:Fetched event
END:VEVENT
END:VCALENDAR
]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      };
    }
  );
  const events = await client.fetchEvents(
    calendar,
    new Date("2026-09-22T00:00:00Z"),
    new Date("2026-09-23T00:00:00Z")
  );
  assert.equal(events[0]?.title, "Fetched event");
  assert.match(reportBody, /<c:expand start="20260922T000000Z" end="20260923T000000Z"/);
  assert.match(reportBody, /<c:time-range start="20260922T000000Z" end="20260923T000000Z"/);
});

test("partitions a fetched window into local days", () => {
  const localDate = (day: number, hour = 0) => new Date(2026, 8, day, hour).toISOString();
  const events: CalendarEvent[] = [
    {
      id: "single",
      title: "Single day",
      start: localDate(22, 9),
      end: localDate(22, 10),
      allDay: false,
      calendar: "Personal",
      calendarId: calendar.id,
    },
    {
      id: "multi",
      title: "Multi-day",
      start: localDate(21),
      end: localDate(24),
      allDay: true,
      calendar: "Personal",
      calendarId: calendar.id,
    },
  ];
  const days = partitionEventsByDay(events, new Date(2026, 8, 20), new Date(2026, 8, 25));
  assert.deepEqual(days.get("2026-09-20")?.map((event) => event.id), []);
  assert.deepEqual(days.get("2026-09-21")?.map((event) => event.id), ["multi"]);
  assert.deepEqual(days.get("2026-09-22")?.map((event) => event.id), ["multi", "single"]);
  assert.deepEqual(days.get("2026-09-23")?.map((event) => event.id), ["multi"]);
  assert.deepEqual(days.get("2026-09-24")?.map((event) => event.id), []);
});
