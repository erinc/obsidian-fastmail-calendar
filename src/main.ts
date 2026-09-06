import { App, FileSystemAdapter, ItemView, Platform, Plugin, PluginSettingTab, WorkspaceLeaf, Notice, Setting } from "obsidian";
import { compactTime, dayStamp, formatRange, momentFormatToRegex, parseDateFromBasename, startOfDay, toLocalISO } from "./dates";

// Node APIs are only available on desktop. Import lazily so mobile never parses them.
declare const require: (id: string) => any;

export const VIEW_TYPE = "apple-calendar-view";

interface CalEvent {
  id: string;
  title: string;
  start: string; // ISO8601
  end: string; // ISO8601
  allDay: boolean;
  calendar: string;
  calendarId: string;
  location?: string;
  url?: string;
}

interface HelperCalendar {
  id: string;
  title: string;
}

interface CalReminder {
  id: string;
  title: string;
  due?: string | null;
  allDay: boolean;
  list: string;
  listId: string;
}

interface DayData {
  events: CalEvent[];
  reminders: CalReminder[];
  remindersError?: string;
}

interface HelperResult {
  events: CalEvent[];
  reminders?: CalReminder[];
  remindersError?: string;
}

interface AppleCalSettings {
  refreshMinutes: number;
  hideSoloTabHeader: boolean;
  hiddenCalendars: string[];
  showReminders: boolean;
}

const DEFAULT_SETTINGS: AppleCalSettings = {
  refreshMinutes: 15,
  hideSoloTabHeader: true,
  hiddenCalendars: [],
  showReminders: true,
};

export default class AppleCalendarPlugin extends Plugin {
  settings: AppleCalSettings = { ...DEFAULT_SETTINGS };
  private refreshTimer: number | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new AppleCalendarView(leaf, this));

    this.addRibbonIcon("calendar", "Open Apple Calendar", () => this.activateView());
    this.addCommand({
      id: "open-apple-calendar",
      name: "Open Apple Calendar",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "refresh-apple-calendar",
      name: "Refresh Apple Calendar",
      callback: () => this.refreshAllViews(false, true),
    });

    this.addSettingTab(new AppleCalSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-open", () => void this.onActiveFileChanged())
    );

    this.app.workspace.onLayoutReady(async () => {
      const pattern = await this.resolveDatePattern();
      if (pattern) this.updateDayFromActiveFile(pattern);
      this.activateView(true);
      this.refreshAllViews(true);
    });

    this.scheduleRefresh();
  }

  onunload() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    if (this.settings.refreshMinutes > 0) {
      this.refreshTimer = window.setInterval(
        () => this.refreshAllViews(true),
        this.settings.refreshMinutes * 60 * 1000
      );
    }
  }

  async activateView(passive = false) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (!passive && leaf) workspace.revealLeaf(leaf);
  }

  refreshAllViews(quiet = false, force = false) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof AppleCalendarView) void view.refresh(quiet, force);
    }
  }

  /** Resolve the helper binary: plugin bin/ -> PATH. */
  resolveHelperPath(): string {
    try {
      // manifest.dir is vault-relative (".obsidian/plugins/obsidian-apple-calendar");
      // resolve it against the vault root to an absolute path.
      const dir = (this as any).manifest?.dir as string | undefined;
      const adapter = this.app.vault.adapter;
      if (dir && adapter instanceof FileSystemAdapter) {
        return adapter.getFullPath(`${dir}/bin/apple-calendar-helper`);
      }
    } catch {
      // fall through to PATH
    }
    return "apple-calendar-helper";
  }

  /** Day shown in the sidebar (local start-of-day). */
  currentDay: Date = startOfDay(new Date());
  private eventCache = new Map<string, { at: number; data: DayData }>();

  /**
   * Recompute the shown day from the active note. Undated notes keep the
   * current day so browsing non-journal notes doesn't yank the calendar.
   * Returns true when the day changed.
   */
  /**
   * What the running Obsidian exposes about Daily Notes. Never throws.
   * enabled is null when the internal API can't say (very old builds).
   */
  dailyNotesRuntime(): { enabled: boolean | null; format: string | null } {
    try {
      const internals = (this.app as any).internalPlugins;
      if (!internals) return { enabled: null, format: null };
      // getEnabledPluginById returns the instance, or null when disabled.
      const inst = internals.getEnabledPluginById?.("daily-notes");
      const raw =
        internals.getPluginById?.("daily-notes") ?? internals.plugins?.["daily-notes"];
      const enabled = inst
        ? true
        : raw
          ? raw.enabled === false
            ? false
            : null
          : false;
      // raw is either the instance ({ options }) or a wrapper
      // ({ enabled, instance }) — accept both so version drift can't lock out.
      const format =
        inst?.options?.format ??
        raw?.options?.format ??
        raw?.instance?.options?.format ??
        inst?.data?.format ??
        raw?.data?.format ??
        raw?.instance?.data?.format ??
        null;
      return { enabled, format: typeof format === "string" && format ? format : null };
    } catch {
      return { enabled: null, format: null };
    }
  }

  /**
   * Daily Notes date format (moment-style), or null when unavailable.
   * Current Obsidian only exposes folder/template on the live instance, so
   * the persisted `.obsidian/daily-notes.json` is the primary source.
   */
  async getDailyNotesFormat(): Promise<string | null> {
    const runtime = this.dailyNotesRuntime();
    if (runtime.format) return runtime.format;
    let filePresent = false;
    let fileFormat: string | null = null;
    try {
      const raw = await this.app.vault.adapter.read(
        `${this.app.vault.configDir}/daily-notes.json`
      );
      filePresent = true;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.format === "string" && parsed.format) fileFormat = parsed.format;
    } catch {
      // No settings file — fall through to the default below.
    }
    // An explicit format wins unless Daily Notes is explicitly disabled.
    if (fileFormat) return runtime.enabled === false ? null : fileFormat;
    // Enabled with an empty format field behaves as Obsidian's default.
    if (runtime.enabled === true || (runtime.enabled === null && filePresent)) {
      return "YYYY-MM-DD";
    }
    return null;
  }

  /** One-line diagnostic for the dev console when Daily Notes detection fails. */
  async describeDailyNotesAccess(): Promise<string> {
    const runtime = this.dailyNotesRuntime();
    let file = "unread";
    try {
      const raw = await this.app.vault.adapter.read(
        `${this.app.vault.configDir}/daily-notes.json`
      );
      const parsed = JSON.parse(raw);
      const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : typeof v);
      file = `keys=[${Object.keys(parsed ?? {}).join(",")}] format=${show(parsed?.format)}`;
    } catch (e) {
      file = `read failed (${String(e)?.slice(0, 80)})`;
    }
    return `daily-notes detect: enabled=${String(runtime.enabled)} runtime.format=${JSON.stringify(runtime.format)} file ${file}`;
  }

  /** Why date resolution failed, for the sidebar error. Null when resolvable. */
  async dateResolutionError(): Promise<string | null> {
    const format = await this.getDailyNotesFormat();
    if (!format) {
      return "Daily Notes is required — enable the Daily Notes core plugin with a numeric date format (e.g. YYYY-MM-DD).";
    }
    if (!momentFormatToRegex(format)) {
      return `Daily Notes format "${format}" can't be matched — switch Daily Notes to a numeric date format (e.g. YYYY-MM-DD).`;
    }
    return null;
  }

  /**
   * Matcher derived from Daily Notes only. Null when Daily Notes is
   * disabled or its format is unmatchable (month/weekday names, times).
   */
  async resolveDatePattern(): Promise<string | null> {
    const format = await this.getDailyNotesFormat();
    if (!format) return null;
    return momentFormatToRegex(format);
  }

  updateDayFromActiveFile(pattern: string): boolean {
    let day = startOfDay(new Date());
    const f = this.app.workspace.getActiveFile();
    if (f) {
      const parsed = parseDateFromBasename(f.basename, pattern);
      if (parsed) {
        day = parsed;
      } else {
        return false;
      }
    }
    if (+day === +this.currentDay) return false;
    this.currentDay = day;
    return true;
  }

  async onActiveFileChanged() {
    const pattern = await this.resolveDatePattern();
    if (!pattern) {
      this.refreshAllViews(true);
      return;
    }
    if (this.updateDayFromActiveFile(pattern)) this.refreshAllViews(true);
  }

  /** Events + reminders for the current day (5-minute in-memory cache per day). */
  fetchDay(force = false): Promise<DayData> {
    const key = `${dayStamp(this.currentDay)}|rem:${this.settings.showReminders ? 1 : 0}`;
    const cached = this.eventCache.get(key);
    if (!force && cached && Date.now() - cached.at < 5 * 60 * 1000) {
      return Promise.resolve({
        events: this.applyCalendarFilter(cached.data.events),
        reminders: cached.data.reminders,
        remindersError: cached.data.remindersError,
      });
    }
    return this.runHelperForDay(this.currentDay).then((data) => {
      this.eventCache.set(key, { at: Date.now(), data });
      if (this.eventCache.size > 14) {
        const oldest = [...this.eventCache.keys()].sort()[0];
        this.eventCache.delete(oldest);
      }
      return { ...data, events: this.applyCalendarFilter(data.events) };
    });
  }

  /** Drop events from hidden calendars (applied after the cache, so toggles take effect immediately). */
  private applyCalendarFilter(events: CalEvent[]): CalEvent[] {
    if (this.settings.hiddenCalendars.length === 0) return events;
    const hidden = new Set(this.settings.hiddenCalendars);
    return events.filter((ev) => !hidden.has(ev.calendarId || ev.calendar));
  }

  /** Spawn the helper, resolving with stdout. Rejects with a human message. */
  private spawnHelper(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!Platform.isDesktop || !Platform.isMacOS) {
        reject(new Error("Apple Calendar view is macOS desktop only."));
        return;
      }
      let spawn: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        spawn = require("child_process").spawn;
      } catch {
        reject(new Error("Node child_process is unavailable in this Obsidian build."));
        return;
      }
      const helper = this.resolveHelperPath();
      const child = spawn(helper, args, { timeout: 15000 });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err: Error) => {
        if ((err as any)?.code === "ENOENT") {
          reject(
            new Error(
              `Helper not found at "${helper}". Build it (npm run helper:build) and copy it into the plugin's bin/ folder.`
            )
          );
        } else {
          reject(err);
        }
      });
      child.on("close", (code: number) => {
        if (code !== 0) {
          const hint = stderr.trim() || stdout.trim() || `exit code ${code}`;
          if (/denied|not authorized|TCC|privacy/i.test(hint)) {
            reject(
              new Error(
                "Calendar access denied. Open System Settings → Privacy & Security → Calendars and allow Obsidian (first run prompts from the helper). " +
                  `Detail: ${hint}`
              )
            );
          } else {
            reject(new Error(`Calendar helper failed: ${hint}`));
          }
          return;
        }
        resolve(stdout);
      });
    });
  }

  /** Run the Swift helper for one local day and parse its JSON. Throws with a human message. */
  private runHelperForDay(day: Date): Promise<DayData> {
    const from = new Date(day);
    const to = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const args = ["--from", toLocalISO(from), "--to", toLocalISO(to), "--json"];
    if (this.settings.showReminders) args.push("--reminders");
    return this.spawnHelper(args).then((stdout) => {
      try {
        const parsed = JSON.parse(stdout) as HelperResult | CalEvent[];
        if (Array.isArray(parsed)) return { events: parsed, reminders: [] };
        const reminders = this.settings.showReminders ? parsed.reminders ?? [] : [];
        return { events: parsed.events ?? [], reminders, remindersError: parsed.remindersError };
      } catch {
        throw new Error(`Calendar helper returned invalid JSON: ${stdout.slice(0, 200)}`);
      }
    });
  }

  /** List available calendars via the helper. Throws with a human message. */
  listCalendars(): Promise<HelperCalendar[]> {
    return this.spawnHelper(["calendars"]).then((stdout) => {
      try {
        const parsed = JSON.parse(stdout) as { calendars: HelperCalendar[] };
        return parsed.calendars ?? [];
      } catch {
        throw new Error(`Calendar helper returned invalid JSON: ${stdout.slice(0, 200)}`);
      }
    });
  }

  /**
   * Open the event in Calendar.app via its ical:// deep link.
   * Deliberately not AppleScript: an unbounded `whose uid` lookup scans
   * entire calendars and hangs on large stores. Failures surface as a Notice.
   */
  openInCalendar(ev: CalEvent): Promise<void> {
    return new Promise((resolve) => {
      let spawn: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        spawn = require("child_process").spawn;
      } catch {
        new Notice("Node child_process is unavailable in this Obsidian build.");
        resolve();
        return;
      }
      const url = `ical://ekevent/${encodeURIComponent(ev.id)}?method=show&options=more`;
      const child = spawn("/usr/bin/open", [url], { timeout: 15000 });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err: Error) => {
        new Notice(`Could not open event in Calendar: ${(err as Error)?.message ?? err}`);
        resolve();
      });
      child.on("close", (code: number | null, signal: string | null) => {
        if (code !== 0) {
          const detail =
            stderr.trim() ||
            (signal ? `killed by ${signal} (Calendar may have hung)` : `exit code ${code}`);
          new Notice(`Could not open event in Calendar: ${detail}`);
        }
        resolve();
      });
    });
  }
}

class AppleCalendarView extends ItemView {
  private plugin: AppleCalendarPlugin;
  private events: CalEvent[] = [];
  private reminders: CalReminder[] = [];
  private remindersError = "";
  private error = "";
  private errorHint = "";
  private loading = false;

  constructor(leaf: WorkspaceLeaf, plugin: AppleCalendarPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Apple Calendar";
  }

  getIcon() {
    return "calendar";
  }

  async onOpen() {
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateTabChrome()));
    this.updateTabChrome();
    await this.refresh(true);
  }

  /**
   * Hide our tab header when we're the only tab in the group (e.g. stacked
   * under the calendar pane), so no redundant tab strip separates the views.
   * Restored automatically when grouped with other tabs.
   */
  updateTabChrome() {
    try {
      const leaf = this.leaf as any;
      const header = (leaf?.tabHeaderEl ?? null) as HTMLElement | null;
      if (!header) return;
      const target = (header.closest(".workspace-tab-header-container") as HTMLElement | null) ?? header;
      if (!this.plugin.settings.hideSoloTabHeader) {
        target.style.display = "";
        return;
      }
      const siblings = (leaf?.parent?.children?.length ?? 1) as number;
      target.style.display = siblings <= 1 ? "none" : "";
    } catch {
      // Non-standard layout — leave the chrome alone.
    }
  }

  async refresh(quiet = false, force = false) {
    if (this.loading) return;
    this.loading = true;
    if (!quiet) this.render();
    const pattern = await this.plugin.resolveDatePattern();
    if (!pattern) {
      console.debug(`[apple-calendar] ${await this.plugin.describeDailyNotesAccess()}`);
      this.error =
        (await this.plugin.dateResolutionError()) ??
        "Daily Notes is required — enable the Daily Notes core plugin with a numeric date format (e.g. YYYY-MM-DD).";
      this.errorHint = "";
      this.loading = false;
      this.render();
      return;
    }
    try {
      const day = await this.plugin.fetchDay(force);
      this.events = day.events;
      this.reminders = day.reminders;
      this.remindersError = day.remindersError ?? "";
      this.error = "";
      this.errorHint = "";
    } catch (e: any) {
      this.error = e?.message ?? String(e);
      this.errorHint = "Read-only. Grant Calendars access in System Settings, then retry.";
      if (!quiet) new Notice(this.error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("obsidian-apple-calendar");

    const showReminders = this.plugin.settings.showReminders;
    const hasContent = this.events.length > 0 || (showReminders && this.reminders.length > 0);
    if (this.loading && !hasContent) {
      el.createEl("p", { text: "Loading…", cls: "obsidian-apple-cal-muted" });
      return;
    }
    if (this.error && !hasContent) {
      el.createEl("p", { text: this.error, cls: "obsidian-apple-cal-error" });
      if (this.errorHint) {
        el.createEl("p", { text: this.errorHint, cls: "obsidian-apple-cal-muted" });
      }
      const retry = el.createEl("button", { text: "Retry", cls: "obsidian-apple-cal-retry" });
      retry.onclick = () => void this.refresh(false, true);
      return;
    }
    // Empty days render nothing — no placeholder text.
    if (!hasContent && !this.remindersError) {
      return;
    }

    if (this.events.length > 0) {
      const sorted = [...this.events].sort((a, b) => +new Date(a.start) - +new Date(b.start));
      const ul = el.createEl("ul", { cls: "obsidian-apple-cal-list" });
      for (const ev of sorted) {
        const li = ul.createEl("li", { cls: "obsidian-apple-cal-item" });
        const title = ev.title || "(no title)";
        const titleEl = li.createEl("div", { text: title, cls: "obsidian-apple-cal-title obsidian-apple-cal-open" });
        titleEl.setAttribute("title", `${title} — open in Calendar`);
        titleEl.onclick = () => void this.plugin.openInCalendar(ev);
        const range = formatRange(ev.start, ev.end, ev.allDay);
        const meta = range ? [range] : [];
        if (ev.calendar) meta.push(ev.calendar);
        if (meta.length > 0) {
          const metaEl = li.createEl("div", { text: meta.join(" · "), cls: "obsidian-apple-cal-meta" });
          metaEl.setAttribute("title", meta.join(" · "));
        }
      }
    }

    // Reminders due on the shown day. Titles are plain text (no deep link
    // into Reminders.app — it has no stable URL scheme like Calendar).
    if (showReminders && (this.reminders.length > 0 || this.remindersError)) {
      el.createEl("div", { text: "Reminders", cls: "obsidian-apple-cal-heading" });
      if (this.remindersError) {
        el.createEl("div", { text: this.remindersError, cls: "obsidian-apple-cal-muted" });
      }
      const ul = el.createEl("ul", { cls: "obsidian-apple-cal-list" });
      for (const rem of this.reminders) {
        const li = ul.createEl("li", { cls: "obsidian-apple-cal-item" });
        li.createEl("div", { text: rem.title || "(no title)", cls: "obsidian-apple-cal-title" });
        const meta: string[] = [];
        if (rem.due && !rem.allDay) {
          try {
            meta.push(compactTime(new Date(rem.due)));
          } catch {
            // Ignore unparseable due dates — list name still shows.
          }
        }
        if (rem.list) meta.push(rem.list);
        if (meta.length > 0) {
          const metaEl = li.createEl("div", { text: meta.join(" · "), cls: "obsidian-apple-cal-meta" });
          metaEl.setAttribute("title", meta.join(" · "));
        }
      }
    }
  }
}



class AppleCalSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AppleCalendarPlugin) {
    super(app, plugin);
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Auto-refresh (minutes)")
      .setDesc("0 disables auto-refresh.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.refreshMinutes)).onChange(async (v) => {
          this.plugin.settings.refreshMinutes = Number(v) || 0;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Show reminders")
      .setDesc("Show Apple Reminders due on the shown day. First use triggers a one-time Reminders permission prompt.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showReminders).onChange(async (v) => {
          this.plugin.settings.showReminders = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews(true, true);
        })
      );
    new Setting(containerEl)
      .setName("Hide tab header when alone")
      .setDesc("Hides this pane's tab strip when it is the only tab in its group (e.g. stacked under the calendar).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.hideSoloTabHeader).onChange(async (v) => {
          this.plugin.settings.hideSoloTabHeader = v;
          await this.plugin.saveSettings();
          for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            const view = leaf.view;
            if (view instanceof AppleCalendarView) view.updateTabChrome();
          }
        })
      );
    const calSection = new Setting(containerEl)
      .setName("Calendars")
      .setDesc("Loading calendar list…");
    void this.plugin.listCalendars().then(
      (cals) => {
        if (cals.length === 0) {
          calSection.setDesc("No calendars found.");
          return;
        }
        calSection.setDesc("Uncheck calendars to hide their events. New calendars show by default.");
        const hidden = new Set(this.plugin.settings.hiddenCalendars);
        for (const cal of cals) {
          new Setting(containerEl)
            .setClass("obsidian-apple-cal-compact")
            .setName(cal.title)
            .addToggle((t) =>
              t.setValue(!hidden.has(cal.id)).onChange(async (v) => {
                const next = new Set(this.plugin.settings.hiddenCalendars);
                if (v) next.delete(cal.id);
                else next.add(cal.id);
                this.plugin.settings.hiddenCalendars = [...next];
                await this.plugin.saveSettings();
                this.plugin.refreshAllViews(true);
              })
            );
        }
      },
      (err: Error) => {
        calSection.setDesc(`Could not load calendars: ${err.message}`);
      }
    );
  }
}
