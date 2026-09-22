import {
  App,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  requestUrl,
  setIcon,
} from "obsidian";
import { dayStamp, formatRange, momentFormatToRegex, parseDateFromBasename, startOfDay } from "./dates";
import {
  CalendarEvent,
  FastmailCalDavClient,
  FastmailCalendar,
  partitionEventsByDay,
} from "./fastmail";

export const VIEW_TYPE = "fastmail-calendar-view";

interface DayData {
  events: CalendarEvent[];
}

interface FastmailCalendarSettings {
  username: string;
  appPassword: string;
  serverUrl: string;
  refreshMinutes: number;
  hideSoloTabHeader: boolean;
  hiddenCalendars: string[];
}

const DEFAULT_SETTINGS: FastmailCalendarSettings = {
  username: "",
  appPassword: "",
  serverUrl: "https://caldav.fastmail.com/",
  refreshMinutes: 15,
  hideSoloTabHeader: true,
  hiddenCalendars: [],
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const WINDOW_RADIUS_DAYS = 7;
const MAX_CACHED_DAYS = 45;

export default class FastmailCalendarPlugin extends Plugin {
  settings: FastmailCalendarSettings = { ...DEFAULT_SETTINGS };
  currentDay: Date = startOfDay(new Date());
  private refreshTimer: number | null = null;
  private eventCache = new Map<string, { at: number; data: DayData }>();
  private calendarCache: { at: number; calendars: FastmailCalendar[] } | null = null;
  private windowFetches = new Map<
    string,
    { from: number; to: number; generation: number; promise: Promise<Map<string, CalendarEvent[]>> }
  >();
  private cacheGeneration = 0;

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new FastmailCalendarView(leaf, this));
    this.addRibbonIcon("calendar", "Open Fastmail Calendar", () => this.activateView());
    this.addCommand({
      id: "open-fastmail-calendar",
      name: "Open Fastmail Calendar",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "refresh-fastmail-calendar",
      name: "Refresh Fastmail Calendar",
      callback: () => this.refreshAllViews(false, true),
    });
    this.addSettingTab(new FastmailCalendarSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("file-open", () => void this.onActiveFileChanged()));
    this.app.workspace.onLayoutReady(async () => {
      const pattern = await this.resolveDatePattern();
      if (pattern) this.updateDayFromActiveFile(pattern);
      await this.activateView(true);
      this.refreshAllViews(true);
    });
    this.scheduleRefresh();
  }

  onunload() {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(clearCaches = false) {
    await this.saveData(this.settings);
    if (clearCaches) this.clearCaches();
    this.scheduleRefresh();
  }

  clearCaches() {
    this.cacheGeneration += 1;
    this.eventCache.clear();
    this.calendarCache = null;
    this.windowFetches.clear();
  }

  isConfigured(): boolean {
    return Boolean(this.settings.username.trim() && this.settings.appPassword);
  }

  private client(): FastmailCalDavClient {
    if (!this.isConfigured()) {
      throw new Error("Add your Fastmail username and app password in the plugin settings.");
    }
    return new FastmailCalDavClient(this.settings, async (options) => {
      const response = await requestUrl({ ...options, throw: false });
      return { status: response.status, text: response.text };
    });
  }

  scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.settings.refreshMinutes > 0) {
      this.refreshTimer = window.setInterval(
        () => this.refreshAllViews(true, true),
        this.settings.refreshMinutes * 60 * 1000
      );
    }
  }

  async activateView(passive = false) {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (!passive) workspace.revealLeaf(leaf);
  }

  refreshAllViews(quiet = false, force = false) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof FastmailCalendarView) void view.refresh(quiet, force);
    }
  }

  dailyNotesRuntime(): { enabled: boolean | null; format: string | null } {
    try {
      const internals = (this.app as any).internalPlugins;
      if (!internals) return { enabled: null, format: null };
      const inst = internals.getEnabledPluginById?.("daily-notes");
      const raw = internals.getPluginById?.("daily-notes") ?? internals.plugins?.["daily-notes"];
      const enabled = inst ? true : raw ? (raw.enabled === false ? false : null) : false;
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

  async getDailyNotesFormat(): Promise<string | null> {
    const runtime = this.dailyNotesRuntime();
    if (runtime.format) return runtime.format;
    let filePresent = false;
    let fileFormat: string | null = null;
    try {
      const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/daily-notes.json`);
      filePresent = true;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.format === "string" && parsed.format) fileFormat = parsed.format;
    } catch {
      // No settings file; use the core plugin state below.
    }
    if (fileFormat) return runtime.enabled === false ? null : fileFormat;
    if (runtime.enabled === true || (runtime.enabled === null && filePresent)) return "YYYY-MM-DD";
    return null;
  }

  async describeDailyNotesAccess(): Promise<string> {
    const runtime = this.dailyNotesRuntime();
    let file = "unread";
    try {
      const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/daily-notes.json`);
      const parsed = JSON.parse(raw);
      const show = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : typeof value);
      file = `keys=[${Object.keys(parsed ?? {}).join(",")}] format=${show(parsed?.format)}`;
    } catch (error) {
      file = `read failed (${String(error).slice(0, 80)})`;
    }
    return `daily-notes detect: enabled=${String(runtime.enabled)} runtime.format=${JSON.stringify(runtime.format)} file ${file}`;
  }

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

  async resolveDatePattern(): Promise<string | null> {
    const format = await this.getDailyNotesFormat();
    return format ? momentFormatToRegex(format) : null;
  }

  updateDayFromActiveFile(pattern: string): boolean {
    let day = startOfDay(new Date());
    const file = this.app.workspace.getActiveFile();
    if (file) {
      const parsed = parseDateFromBasename(file.basename, pattern);
      if (!parsed) return false;
      day = parsed;
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

  async listCalendars(force = false): Promise<FastmailCalendar[]> {
    if (!force && this.calendarCache && Date.now() - this.calendarCache.at < 10 * 60 * 1000) {
      return this.calendarCache.calendars;
    }
    const generation = this.cacheGeneration;
    const calendars = await this.client().listCalendars();
    if (generation === this.cacheGeneration) {
      this.calendarCache = { at: Date.now(), calendars };
    }
    return calendars;
  }

  async fetchDay(day: Date, force = false): Promise<DayData> {
    const requestedDay = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const key = dayStamp(requestedDay);
    const cached = this.eventCache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.data;
    }

    const from = new Date(
      requestedDay.getFullYear(),
      requestedDay.getMonth(),
      requestedDay.getDate() - WINDOW_RADIUS_DAYS
    );
    const to = new Date(
      requestedDay.getFullYear(),
      requestedDay.getMonth(),
      requestedDay.getDate() + WINDOW_RADIUS_DAYS + 1
    );
    const generation = this.cacheGeneration;
    const windowKey = `${generation}:${dayStamp(from)}:${dayStamp(to)}`;
    let pending = [...this.windowFetches.values()].find(
      (request) =>
        request.generation === generation &&
        requestedDay.getTime() >= request.from &&
        requestedDay.getTime() < request.to
    )?.promise;
    if (!pending) {
      pending = this.fetchWindow(from, to, force, generation);
      this.windowFetches.set(windowKey, {
        from: from.getTime(),
        to: to.getTime(),
        generation,
        promise: pending,
      });
      const clearPending = () => {
        if (this.windowFetches.get(windowKey)?.promise === pending) this.windowFetches.delete(windowKey);
      };
      void pending.then(clearPending, clearPending);
    }
    const days = await pending;
    return { events: days.get(key) ?? [] };
  }

  private async fetchWindow(
    from: Date,
    to: Date,
    forceCalendars: boolean,
    generation: number
  ): Promise<Map<string, CalendarEvent[]>> {
    const calendars = await this.listCalendars(forceCalendars);
    const hidden = new Set(this.settings.hiddenCalendars);
    const visible = calendars.filter((calendar) => !hidden.has(calendar.id));
    const batches = await Promise.all(
      visible.map((calendar) => this.client().fetchEvents(calendar, from, to))
    );
    const days = partitionEventsByDay(batches.flat(), from, to);
    if (generation === this.cacheGeneration) {
      const fetchedAt = Date.now();
      for (const [key, events] of days) {
        this.eventCache.set(key, { at: fetchedAt, data: { events } });
      }
      while (this.eventCache.size > MAX_CACHED_DAYS) {
        const oldest = [...this.eventCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
        if (!oldest) break;
        this.eventCache.delete(oldest);
      }
    }
    return days;
  }

  openInFastmail() {
    window.open("https://app.fastmail.com/calendar/", "_blank", "noopener");
  }
}

class FastmailCalendarView extends ItemView {
  private events: CalendarEvent[] = [];
  private error = "";
  private errorHint = "";
  private loading = false;
  private shownDay = "";
  private refreshGeneration = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: FastmailCalendarPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Fastmail Calendar";
  }

  getIcon() {
    return "calendar";
  }

  async onOpen() {
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateTabChrome()));
    this.updateTabChrome();
    await this.refresh(true);
  }

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
      target.style.display = (leaf?.parent?.children?.length ?? 1) <= 1 ? "none" : "";
    } catch {
      // Leave non-standard layouts untouched.
    }
  }

  async refresh(quiet = false, force = false) {
    const generation = ++this.refreshGeneration;
    const requestedDay = new Date(
      this.plugin.currentDay.getFullYear(),
      this.plugin.currentDay.getMonth(),
      this.plugin.currentDay.getDate()
    );
    const requestedStamp = dayStamp(requestedDay);
    const dayChanged = requestedStamp !== this.shownDay;
    this.shownDay = requestedStamp;
    this.loading = true;
    if (dayChanged) {
      this.events = [];
      this.error = "";
      this.errorHint = "";
    }
    if (dayChanged || !quiet) this.render();
    const pattern = await this.plugin.resolveDatePattern();
    if (generation !== this.refreshGeneration) return;
    if (!pattern) {
      const diagnostic = await this.plugin.describeDailyNotesAccess();
      if (generation !== this.refreshGeneration) return;
      console.debug(`[fastmail-calendar] ${diagnostic}`);
      this.error =
        (await this.plugin.dateResolutionError()) ??
        "Daily Notes is required — enable it with a numeric date format.";
      if (generation !== this.refreshGeneration) return;
      this.errorHint = "";
      this.events = [];
      this.loading = false;
      this.render();
      return;
    }
    try {
      const day = await this.plugin.fetchDay(requestedDay, force);
      if (generation !== this.refreshGeneration) return;
      this.events = day.events;
      this.error = "";
      this.errorHint = "";
    } catch (error: any) {
      if (generation !== this.refreshGeneration) return;
      this.error = error?.message ?? String(error);
      this.events = [];
      this.errorHint = this.plugin.isConfigured()
        ? "Check the connection in Fastmail Calendar settings, then retry."
        : "Open Fastmail Calendar settings to connect your account.";
      if (!quiet) new Notice(this.error);
    } finally {
      if (generation === this.refreshGeneration) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render() {
    const element = this.contentEl;
    element.empty();
    element.addClass("obsidian-fastmail-calendar");
    if (this.loading && this.events.length === 0) {
      element.createEl("p", { text: "Loading…", cls: "obsidian-fastmail-cal-muted" });
      return;
    }
    if (this.error && this.events.length === 0) {
      element.createEl("p", { text: this.error, cls: "obsidian-fastmail-cal-error" });
      if (this.errorHint) element.createEl("p", { text: this.errorHint, cls: "obsidian-fastmail-cal-muted" });
      const retry = element.createEl("button", { text: "Retry", cls: "obsidian-fastmail-cal-retry" });
      retry.onclick = () => void this.refresh(false, true);
      return;
    }
    if (this.events.length === 0) return;

    const list = element.createEl("ul", { cls: "obsidian-fastmail-cal-list" });
    for (const event of this.events) {
      const item = list.createEl("li", { cls: "obsidian-fastmail-cal-item" });
      const row = item.createEl("div", { cls: "obsidian-fastmail-cal-row" });
      const icon = row.createEl("span", { cls: "obsidian-fastmail-cal-icon" });
      setIcon(icon, "calendar");
      const title = event.title || "(no title)";
      const titleElement = row.createEl("div", {
        text: title,
        cls: "obsidian-fastmail-cal-title obsidian-fastmail-cal-open",
      });
      titleElement.setAttribute("title", `${title} — open Fastmail Calendar`);
      titleElement.onclick = () => this.plugin.openInFastmail();
      const range = formatRange(event.start, event.end, event.allDay);
      const metaText = [range, event.calendar].filter(Boolean).join(" · ");
      if (metaText) {
        const metaElement = item.createEl("div", {
          text: metaText,
          cls: "obsidian-fastmail-cal-meta obsidian-fastmail-cal-meta-indent",
        });
        metaElement.setAttribute("title", metaText);
      }
    }
  }
}

class FastmailCalendarSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: FastmailCalendarPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Fastmail Calendar" });
    containerEl.createEl("p", {
      text: "Use your full Fastmail email address and a calendar-enabled app password. The password is stored in Obsidian's local plugin data.",
      cls: "setting-item-description",
    });
    new Setting(containerEl)
      .setName("Fastmail username")
      .setDesc("Your full Fastmail email address, including the domain.")
      .addText((text) =>
        text.setPlaceholder("you@example.com").setValue(this.plugin.settings.username).onChange(async (value) => {
          this.plugin.settings.username = value.trim();
          await this.plugin.saveSettings(true);
        })
      );
    new Setting(containerEl)
      .setName("App password")
      .setDesc("Create one in Fastmail → Settings → Privacy & Security → Manage app passwords.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Fastmail app password").setValue(this.plugin.settings.appPassword).onChange(async (value) => {
          this.plugin.settings.appPassword = value;
          await this.plugin.saveSettings(true);
        });
      });
    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Tests the credentials and reloads the calendar list.")
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(async () => {
          button.setDisabled(true).setButtonText("Testing…");
          try {
            const calendars = await this.plugin.listCalendars(true);
            new Notice(`Connected to Fastmail. Found ${calendars.length} calendar${calendars.length === 1 ? "" : "s"}.`);
            this.display();
            this.plugin.refreshAllViews(true, true);
          } catch (error: any) {
            new Notice(error?.message ?? String(error));
            button.setDisabled(false).setButtonText("Test connection");
          }
        })
      );
    new Setting(containerEl)
      .setName("Auto-refresh (minutes)")
      .setDesc("0 disables auto-refresh.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.refreshMinutes)).onChange(async (value) => {
          this.plugin.settings.refreshMinutes = Math.max(0, Number(value) || 0);
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Hide tab header when alone")
      .setDesc("Hides this pane's tab strip when it is the only tab in its group.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideSoloTabHeader).onChange(async (value) => {
          this.plugin.settings.hideSoloTabHeader = value;
          await this.plugin.saveSettings();
          for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            const view = leaf.view;
            if (view instanceof FastmailCalendarView) view.updateTabChrome();
          }
        })
      );

    const calendarSection = new Setting(containerEl).setName("Calendars");
    if (!this.plugin.isConfigured()) {
      calendarSection.setDesc("Enter your Fastmail credentials above to load calendars.");
      return;
    }
    calendarSection.setDesc("Loading calendar list…");
    void this.plugin.listCalendars().then(
      (calendars) => {
        if (calendars.length === 0) {
          calendarSection.setDesc("No calendars found.");
          return;
        }
        calendarSection.setDesc("Uncheck calendars to hide their events. New calendars show by default.");
        const hidden = new Set(this.plugin.settings.hiddenCalendars);
        for (const calendar of calendars) {
          new Setting(containerEl)
            .setClass("obsidian-fastmail-cal-compact")
            .setName(calendar.title)
            .addToggle((toggle) =>
              toggle.setValue(!hidden.has(calendar.id)).onChange(async (value) => {
                const next = new Set(this.plugin.settings.hiddenCalendars);
                if (value) next.delete(calendar.id);
                else next.add(calendar.id);
                this.plugin.settings.hiddenCalendars = [...next];
                this.plugin.clearCaches();
                await this.plugin.saveSettings();
                this.plugin.refreshAllViews(true, true);
              })
            );
        }
      },
      (error: Error) => calendarSection.setDesc(`Could not load calendars: ${error.message}`)
    );
  }
}
