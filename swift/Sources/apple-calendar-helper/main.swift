// Read-only macOS Calendar dump via EventKit. Outputs JSON to stdout.
// Usage:
//   apple-calendar-helper --days 7 --json [--reminders]
//   apple-calendar-helper --from 2026-09-04T00:00:00 --to 2026-09-11T00:00:00 --json [--reminders]
//   apple-calendar-helper calendars
import EventKit
import Foundation

struct CalEvent: Encodable {
  let id: String
  let title: String
  let start: String
  let end: String
  let allDay: Bool
  let calendar: String
  let calendarId: String
  let location: String?
  let url: String?
}

struct CalReminder: Encodable {
  let id: String
  let title: String
  let due: String?
  let allDay: Bool
  let list: String
  let listId: String
}

struct Payload: Encodable {
  let events: [CalEvent]
  let reminders: [CalReminder]?
  let remindersError: String?
}

func eprint(_ s: String) {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

func parseArgs() -> (days: Int, from: Date?, to: Date?, calendars: Bool, reminders: Bool) {
  var days = 7
  var from: Date? = nil
  var to: Date? = nil
  var calendars = false
  var reminders = false
  let args = CommandLine.arguments
  var i = 1
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime]
  let isoNoTZ = DateFormatter()
  isoNoTZ.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
  isoNoTZ.timeZone = TimeZone.current
  func parseDate(_ s: String) -> Date? {
    if let d = iso.date(from: s) { return d }
    return isoNoTZ.date(from: s)
  }
  while i < args.count {
    let a = args[i]
    if a == "calendars" { calendars = true }
    else if a == "--reminders" { reminders = true }
    else if a == "--days", i + 1 < args.count { days = max(1, min(30, Int(args[i+1]) ?? 7)); i += 1 }
    else if a == "--from", i + 1 < args.count { from = parseDate(args[i+1]); i += 1 }
    else if a == "--to", i + 1 < args.count { to = parseDate(args[i+1]); i += 1 }
    // --json accepted for forward-compat; output is always JSON
    i += 1
  }
  return (days, from, to, calendars, reminders)
}

func requestAccess(_ store: EKEventStore) -> Bool {
  if #available(macOS 14.0, *) {
    // Modern full-access API (read requires full access).
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    Task {
      do {
        granted = try await store.requestFullAccessToEvents()
      } catch {
        eprint("Calendar access request failed: \(error.localizedDescription)")
        granted = false
      }
      sem.signal()
    }
    sem.wait()
    return granted
  } else {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    store.requestAccess(to: .event) { ok, err in
      if let err = err { eprint("Calendar access request failed: \(err.localizedDescription)") }
      granted = ok
      sem.signal()
    }
    sem.wait()
    return granted
  }
}

func requestReminderAccess(_ store: EKEventStore) -> Bool {
  if #available(macOS 14.0, *) {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    Task {
      do {
        granted = try await store.requestFullAccessToReminders()
      } catch {
        eprint("Reminders access request failed: \(error.localizedDescription)")
        granted = false
      }
      sem.signal()
    }
    sem.wait()
    return granted
  } else {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    store.requestAccess(to: .reminder) { ok, err in
      if let err = err { eprint("Reminders access request failed: \(err.localizedDescription)") }
      granted = ok
      sem.signal()
    }
    sem.wait()
    return granted
  }
}

let (days, fromArg, toArg, listCalendars, wantReminders) = parseArgs()
let store = EKEventStore()

guard requestAccess(store) else {
  eprint("Calendar access denied. Allow in System Settings → Privacy & Security → Calendars, then re-run.")
  exit(2)
}

if listCalendars {
  struct Cal: Encodable { let id: String; let title: String; let type: String; let allowsContentModifications: Bool }
  let cals = (store.calendars(for: .event)).map {
    Cal(id: $0.calendarIdentifier, title: $0.title, type: "\($0.source.sourceType.rawValue)", allowsContentModifications: $0.allowsContentModifications)
  }
  let data = try! JSONEncoder().encode(["calendars": cals])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

let start: Date
let end: Date
if let f = fromArg {
  start = f
  end = toArg ?? Calendar.current.date(byAdding: .day, value: days, to: f)!
} else {
  start = Calendar.current.startOfDay(for: Date())
  end = Calendar.current.date(byAdding: .day, value: days, to: start)!
}

let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil as [EKCalendar]?)
let ekEvents: [EKEvent] = store.events(matching: predicate)

let isoOut = ISO8601DateFormatter()
isoOut.formatOptions = [.withInternetDateTime]
var events: [CalEvent] = []
events.reserveCapacity(ekEvents.count)
for ev: EKEvent in ekEvents {
  // calendarItemIdentifier (not eventIdentifier) matches Calendar.app's AppleScript uid.
  let item = CalEvent(
    id: ev.calendarItemIdentifier,
    title: ev.title ?? "(no title)",
    start: isoOut.string(from: ev.startDate),
    end: isoOut.string(from: ev.endDate),
    allDay: ev.isAllDay,
    calendar: ev.calendar.title,
    calendarId: ev.calendar.calendarIdentifier,
    location: ev.location,
    url: ev.url?.absoluteString
  )
  events.append(item)
}
events.sort { $0.start < $1.start }

// Reminders due on the shown day(s). Only fetched with --reminders, so the
// Reminders permission prompt appears solely when the user opts in.
var reminders: [CalReminder]? = nil
var remindersError: String? = nil
if wantReminders {
  guard requestReminderAccess(store) else {
    remindersError = "Reminders access denied. Allow in System Settings → Privacy & Security → Reminders, then re-run."
    reminders = []
    let payload = Payload(events: events, reminders: reminders, remindersError: remindersError)
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    print(String(data: try! enc.encode(payload), encoding: .utf8)!)
    exit(0)
  }
  let predicate = store.predicateForIncompleteReminders(withDueDateStarting: start, ending: end, calendars: nil)
  let sem = DispatchSemaphore(value: 0)
  var fetched: [EKReminder]? = nil
  // fetchReminders exists on all supported macOS versions; the async variant
  // is macOS 15+ only, so stay on the completion-handler form.
  store.fetchReminders(matching: predicate) { found in
    fetched = found
    sem.signal()
  }
  sem.wait()
  var out: [CalReminder] = []
  out.reserveCapacity(fetched?.count ?? 0)
  for rem in fetched ?? [] {
    var dueISO: String? = nil
    var timed = false
    if let comps = rem.dueDateComponents,
       let due = Calendar.current.date(from: comps) {
      dueISO = isoOut.string(from: due)
      timed = comps.hour != nil
    }
    out.append(CalReminder(
      id: rem.calendarItemIdentifier,
      title: rem.title ?? "(no title)",
      due: dueISO,
      allDay: !timed,
      list: rem.calendar?.title ?? "",
      listId: rem.calendar?.calendarIdentifier ?? ""
    ))
  }
  out.sort { ($0.due ?? "") < ($1.due ?? "") }
  reminders = out
}

let payload = Payload(events: events, reminders: reminders, remindersError: remindersError)
let enc = JSONEncoder()
enc.outputFormatting = [.sortedKeys]
print(String(data: try! enc.encode(payload), encoding: .utf8)!)
