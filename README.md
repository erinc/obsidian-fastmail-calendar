# Fastmail Calendar for Obsidian

A read-only Obsidian sidebar for Fastmail Calendar. The view follows the date
of the Daily Note you have open and shows events from the Fastmail calendars
you choose.

This is an independent community plugin and is not affiliated with or
endorsed by Fastmail or Obsidian.

## Features

- Reads calendars directly from Fastmail using standard CalDAV over HTTPS.
- Discovers personal, shared, and subscribed calendars exposed by the account.
- Follows numeric Daily Note filenames such as `2026-09-22`, `22-09-2026`, or
  `9-22-2026`.
- Handles timed events, all-day events, multi-day events, time zones, floating
  times, recurring events, and recurrence exceptions.
- Lets you hide individual calendars without changing anything in Fastmail.
- Loads a rolling 15-day window so navigation between nearby journal dates is
  immediate after the first request.
- Protects the view from stale responses when dates are changed quickly.
- Opens Fastmail Calendar when an event title is selected.
- Runs without a native helper on Linux, macOS, Windows, and Obsidian mobile.

The plugin is strictly read-only. Its CalDAV client only sends `PROPFIND` and
`REPORT` requests; it does not create, update, move, or delete calendar data.

## Requirements

- Obsidian 1.4.0 or newer.
- A Fastmail plan that includes CalDAV access.
- A dedicated Fastmail app password with calendar access.
- Obsidian's **Daily Notes** core plugin enabled.
- A numeric Daily Notes filename format containing year, month, and day.

Do not use your normal Fastmail account password. Fastmail requires an app
password for CalDAV clients.

## Installation

### Manual installation

Create the plugin directory in your vault and copy the release artifacts into
it:

```text
<vault>/.obsidian/plugins/obsidian-fastmail-calendar/
├── main.js
├── manifest.json
└── styles.css
```

Reload Obsidian, open **Settings → Community plugins**, and enable
**Fastmail Calendar**.

### Build from source

Node.js 20 or newer and npm are required.

```bash
git clone https://github.com/erinc/obsidian-fastmail-calendar.git
cd obsidian-fastmail-calendar
npm install
npm run check
```

`npm run check` type-checks the source, runs the test suite, and creates the
production `main.js` bundle.

Copy the bundle into a vault:

```bash
VAULT_PLUGIN="<vault>/.obsidian/plugins/obsidian-fastmail-calendar"
mkdir -p "$VAULT_PLUGIN"
cp manifest.json main.js styles.css "$VAULT_PLUGIN/"
```

Reload Obsidian after replacing an existing build.

## Fastmail setup

1. Open Fastmail.
2. Go to **Settings → Privacy & Security → Manage app passwords**.
3. Create a dedicated app password with calendar access.
4. In Obsidian, go to **Settings → Fastmail Calendar**.
5. Enter your full Fastmail username, including its domain.
6. Enter the new app password.
7. Select **Test connection**.
8. Use the calendar toggles to hide any calendars you do not want in the
   sidebar.

The connection test discovers the account's calendar collections but does not
modify them.

## Usage

Use the calendar ribbon icon or the **Open Fastmail Calendar** command to open
the sidebar. It also opens automatically when the workspace is ready.

When a Daily Note is opened, the plugin derives its date from the configured
Daily Notes format and displays events that overlap that local day. Opening an
undated or non-journal note clears the sidebar and does not make a calendar
request. The sidebar also stays empty when no note is open.

Each event row contains:

- the event title;
- its time range for a single-day timed event;
- its date range for a multi-day event; and
- the Fastmail calendar name.

Single-day all-day events show only the calendar name. Selecting an event title
opens the Fastmail Calendar web application. CalDAV does not provide a stable
Fastmail web deep link for every individual event.

Empty days intentionally render an empty pane.

## Daily Notes formats

The matcher is derived from Obsidian's Daily Notes configuration. Numeric
formats work in different component orders, including:

- `YYYY-MM-DD`
- `DD-MM-YYYY`
- `M-D-YYYY`
- `YYYY/MM/DD`
- formats containing Moment-style literal sections such as `[Daily] YYYY-MM-DD`

Formats containing month names, weekday names, times, duplicate date
components, or missing year/month/day components are rejected because they
cannot be matched reliably against a note basename.

## Performance and caching

For an uncached date, the plugin fetches the selected date plus seven days on
either side. It sends one calendar query per visible calendar, in parallel,
then partitions the returned events into 15 local-day cache entries.

- Nearby date navigation is served from memory and is normally immediate.
- Cached entries expire after five minutes.
- At most 45 days are retained in memory.
- The default background refresh is every 15 minutes and refreshes the current
  15-day window.
- Rapid navigation reuses a compatible in-progress request.
- Older responses are discarded if a newer date selection supersedes them.
- Events are not written to disk and the cache is cleared when Obsidian unloads
  the plugin.

Changing credentials or calendar visibility clears the cache.
Set auto-refresh to `0` to disable periodic network requests.

## Settings

### Fastmail username

The complete Fastmail login address, including the domain.

### App password

A dedicated Fastmail app password with calendar access. The field is visually
masked, but see [Privacy and security](#privacy-and-security) for how Obsidian
stores plugin settings.

### Connection

Tests authentication and reloads the list of available calendars.

### Auto-refresh

The number of minutes between background refreshes. The default is 15; `0`
disables it.

### Hide tab header when alone

Removes the pane's tab strip when it is the only tab in its group. The header
returns automatically if another tab joins the group.

### Calendars

Every discovered calendar is visible by default. Uncheck a calendar to exclude
it from future requests and clear the existing event cache.

## Privacy and security

The plugin is designed to keep the connection direct and narrowly scoped:

- Calendar requests go from Obsidian directly to Fastmail's official CalDAV
  server at `https://caldav.fastmail.com/`.
- There is no plugin-operated proxy, analytics service, telemetry, advertising,
  crash reporting, or other third-party backend.
- HTTPS is mandatory. The client refuses non-Fastmail origins and URLs with
  embedded usernames or passwords, so the app password cannot be configured
  for transmission to another server.
- Authentication uses the Fastmail username and app password in the HTTPS
  `Authorization` header.
- Only read-only CalDAV discovery and query methods are implemented.
- Calendar event data is kept in memory only and is not persisted by the
  plugin.
- Event titles and metadata are inserted into the Obsidian interface as text,
  not as executable HTML.
- Errors shown to the user do not include the authorization header or app
  password.

Obsidian stores the username, calendar visibility choices, plugin preferences,
and app password in:

```text
<vault>/.obsidian/plugins/obsidian-fastmail-calendar/data.json
```

That file is plain JSON; the app password is not encrypted at rest. Depending
on how the vault is synchronized or backed up, the file may be copied to other
devices or storage providers. Use a dedicated, calendar-scoped app password,
protect the vault and its backups, and revoke the password in Fastmail if a
device or copy of the vault is lost.

The repository ignores `data.json`, `.env` files, private keys, and certificate
files to reduce the chance of accidentally committing credentials.

## Network behavior

The plugin connects only to Fastmail paths beneath:

```text
https://caldav.fastmail.com/dav/calendars/user/<username>/
```

It uses:

- `PROPFIND` to list calendar collections; and
- `REPORT` with a CalDAV time-range filter to retrieve events.

No mail, contacts, files, tasks, or account settings are requested.

## Troubleshooting

### Fastmail rejects the username or app password

- Confirm the username is the full Fastmail login address.
- Create a new app password with calendar access.
- Do not enter the regular Fastmail password.
- Press **Test connection** again after saving the new password.

### No calendars are found

- Confirm the Fastmail plan includes CalDAV.
- Check that the app password permits calendar access.
- Verify calendars are visible in Fastmail itself.

### Daily Notes is required

Enable Obsidian's Daily Notes core plugin and choose a numeric date format with
year, month, and day components.

### The sidebar briefly says Loading

The selected date is outside the current 15-day memory window or the cache has
expired. Once the request completes, nearby dates are cached together.

### An event title opens the calendar rather than the exact event

Fastmail's CalDAV response does not expose a stable web-application deep link
for every event. The plugin therefore opens the Fastmail Calendar page.

### Changes in Fastmail do not appear immediately

Run **Refresh Fastmail Calendar**, press **Retry**, or wait for the next
auto-refresh interval. A forced refresh replaces the current cached window.

## Migrating from the Apple Calendar version

This repository originally used a macOS-only Swift/EventKit helper. Version
0.2.0 replaces that architecture with direct Fastmail CalDAV access.

- The plugin ID is now `obsidian-fastmail-calendar`.
- The native Swift helper is no longer used or distributed.
- Apple Calendar permissions and Apple Reminders are no longer involved.
- Existing Apple Calendar plugin settings do not contain Fastmail credentials
  and are not migrated.

After confirming the Fastmail version works, disable and remove the old
`obsidian-apple-calendar` plugin directory manually if it is still installed.

## Development

Repository layout:

```text
src/main.ts       Obsidian lifecycle, sidebar, settings, and cache
src/fastmail.ts   CalDAV transport, XML parsing, and iCalendar parsing
src/dates.ts      Daily Note matching and display formatting
tests/            Protocol, recurrence, security, and cache tests
```

Available commands:

```bash
npm run dev    # watch and rebuild main.js
npm run build  # create a production main.js
npm test       # run the TypeScript test suite
npm run check  # type-check, test, and build
```

The automated tests cover:

- timed and all-day events;
- recurring events and recurrence exceptions;
- Fastmail calendar discovery paths;
- CalDAV time-range queries;
- rejection of insecure or non-Fastmail server URLs; and
- partitioning a fetched window into local-day cache entries.

Before publishing a build, run:

```bash
npm ci
npm run check
npm audit
```

Only `main.js`, `manifest.json`, and `styles.css` are needed at runtime.
