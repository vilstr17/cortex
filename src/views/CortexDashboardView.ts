import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon, moment } from "obsidian";
import CortexPlugin from "../main.js";
import { DisplayCalendarEvent } from "../services/googleCalendarService.js";
import { CortexChatModal } from "../modals/CortexChatModal.js";
import { CreateTestModal } from "../modals/CreateTestModal.js";
import { ReviewFilterModal, ReviewFilters } from "../modals/ReviewFilterModal.js";
import { TestService } from "../services/testService.js";
import { CortexTest } from "../settings.js";
import { localISODate, parseLocalDate, startOfLocalDay, isSameLocalDay, addDays, daysUntil } from "../utils/dateUtils.js";
import { providerMissingFields, PROVIDER_LABELS } from "../services/ai/catalog.js";

export const CORTEX_DASHBOARD_VIEW = "cortex-dashboard";

interface DueNote {
	file: TFile;
	nextReview: Date;
	isOverdue: boolean;
}

interface ReviewFilterOptions {
	sortOrder: "low-to-high" | "high-to-low";
	selectedTestIds: Set<string>;
}

export class CortexDashboardView extends ItemView {
	private plugin: CortexPlugin;
	private reviewsContainer!: HTMLElement;
	private scheduleContainer!: HTMLElement;
	private authContainer!: HTMLElement;
	private testsContainer!: HTMLElement;
	private testService!: TestService;
	private lastCalendarFetch = 0;
	private lastFetchedEvents: DisplayCalendarEvent[] | null = null;
	private lastFetchedCalendarDate: Date | null = null;

	private currentCalendarDate: Date = new Date();
	private currentReviewsDate: Date = new Date();
	private reviewFilters: ReviewFilterOptions = {
		sortOrder: "low-to-high",
		selectedTestIds: new Set(),
	};

	constructor(leaf: WorkspaceLeaf, plugin: CortexPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return CORTEX_DASHBOARD_VIEW; }
	getDisplayText(): string { return "Cortex Dashboard"; }
	getIcon(): string { return "brain"; }

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();

		this.testService = this.plugin.testService;

		const wrapper = container.createDiv({ cls: "cortex-dashboard" });

		const headerRow = wrapper.createDiv({ cls: "cortex-header-row" });
		headerRow.createEl("h1", { text: "Cortex Command Center" });

		const chatBtn = headerRow.createEl("button", { cls: "cortex-chat-icon-btn" });
		chatBtn.setAttr("title", "Open Cortex AI Chat");
		setIcon(chatBtn, "message-square");
		chatBtn.addEventListener("click", () => {
			// Provider-aware credentials check — same logic as the chat
			// modal's sendMessage. Surface the missing field name so the
			// user knows exactly what to set.
			const ai = this.plugin.settings.ai;
			const missing = providerMissingFields(ai.provider, {
				cortexAccountId: ai.cortexAccountId,
				geminiApiKey: ai.geminiApiKey,
				geminiModel: ai.geminiModel,
				apiKey: ai.apiKey,
				model: ai.model,
				baseUrl: ai.baseUrl,
			});
			if (missing.length > 0) {
				new Notice(
					`Cortex: ${PROVIDER_LABELS[ai.provider]} is not configured. Missing: ${missing.join(", ")}. Set them in Settings → Cortex.`,
				);
				return;
			}
			new CortexChatModal(this.app, this.plugin).open();
		});

		const refreshBtn = headerRow.createEl("button", { cls: "cortex-refresh-btn clickable-icon" });
		refreshBtn.setAttr("title", "Refresh");
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			this.lastCalendarFetch = 0;
			this.lastFetchedEvents = null;
			this.lastFetchedCalendarDate = null;
			this.render();
		});

		this.reviewsContainer = wrapper.createDiv({ cls: "cortex-reviews-section" });
		this.scheduleContainer = wrapper.createDiv({ cls: "cortex-schedule-section" });
		this.testsContainer = wrapper.createDiv({ cls: "cortex-tests-section" });
		this.authContainer = wrapper.createDiv({ cls: "cortex-auth-section" });

		// Debounced: while editing, metadata changes fire on every save —
		// re-rendering the whole dashboard (incl. a calendar fetch) each
		// time causes visible lag.
		let renderTimer: ReturnType<typeof setTimeout> | null = null;
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					if (renderTimer) clearTimeout(renderTimer);
					renderTimer = setTimeout(() => {
						this.renderReviews();
						this.renderTests();
					}, 2000);
				}
			}),
		);

		this.render();
	}

	async onClose(): Promise<void> {
	}

	private async render(): Promise<void> {
		this.renderCalendar();
		this.renderReviews();
		this.renderTests();
	}

	private renderCalendar(): void {
		this.renderGoogleCalendarSection();
	}

	private renderReviews(): void {
		this.renderDueReviews();
	}

	private renderTests(): void {
		this.renderUpcomingTests();
	}

	private renderGoogleCalendarSection(): void {
		this.authContainer.empty();
		this.scheduleContainer.empty();
		if (!this.plugin.settings.googleAccessToken) { this.renderConnectButton(); return; }
		this.renderTodaysSchedule();
	}

	private renderConnectButton(): void {
		this.authContainer.createEl("p", {
			text: "Connect your Google Calendar to see today's schedule alongside your reviews.",
			cls: "cortex-calendar-connect-desc",
		});
		const btn = this.authContainer.createEl("button", { cls: "cortex-connect-google-btn", text: "Connect Google Calendar" });
		btn.addEventListener("click", async () => { await this.handleConnectGoogleCalendar(); });
	}

	private async handleConnectGoogleCalendar(): Promise<void> {
		const state = this.plugin.generateOAuthState();
		window.open(`https://cortex-proxy.vercel.app/api/auth?state=${encodeURIComponent(state)}`);
		this.authContainer.empty();
		const el = this.authContainer.createDiv({ cls: "cortex-auth-status" });
		el.createEl("h4", { text: "Waiting for authorization\u2026" });
		el.createEl("p", { text: "Please complete the login in your web browser.", cls: "cortex-auth-hint" });
	}

	private async renderTodaysSchedule(): Promise<void> {
		const srv = this.plugin.getCalendarService();
		const now = Date.now();
		const dateChanged = !this.lastFetchedCalendarDate || this.lastFetchedCalendarDate.getTime() !== this.currentCalendarDate.getTime();
		const stale = now - this.lastCalendarFetch > 30000;
		let events: DisplayCalendarEvent[];
		if (!this.lastFetchedEvents || dateChanged || stale) {
			events = await srv.getEventsForDay(this.currentCalendarDate);
			this.lastCalendarFetch = now;
			this.lastFetchedCalendarDate = new Date(this.currentCalendarDate);
			this.lastFetchedEvents = events;
		} else {
			events = this.lastFetchedEvents;
		}
		this.scheduleContainer.empty();

		const hr = this.scheduleContainer.createDiv({ cls: "cortex-dashboard-header-row" });
		hr.style.display = "flex"; hr.style.justifyContent = "space-between"; hr.style.alignItems = "center"; hr.style.marginBottom = "10px";
		const titleStr = isSameLocalDay(this.currentCalendarDate, new Date()) ? `Today's Schedule (${events.length})` : `${this.currentCalendarDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} Schedule (${events.length})`;
		const t = hr.createEl("h2", { text: titleStr }); t.style.margin = "0";

		const nav = this.createDateNav(hr,
			() => { const d = new Date(this.currentCalendarDate); d.setDate(d.getDate() - 1); this.currentCalendarDate = d; this.renderTodaysSchedule(); },
			() => { this.currentCalendarDate = startOfLocalDay(new Date()); this.renderTodaysSchedule(); },
			() => { const d = new Date(this.currentCalendarDate); d.setDate(d.getDate() + 1); this.currentCalendarDate = d; this.renderTodaysSchedule(); },
		);

		if (events.length === 0) { this.scheduleContainer.createDiv({ cls: "cortex-schedule-placeholder", text: "No events scheduled for this day." }); return; }

		const list = this.scheduleContainer.createEl("div", { cls: "cortex-event-list" });
		for (const ev of events) {
			const item = list.createDiv({ cls: "cortex-event-item" });
			item.createEl("span", { cls: "cortex-event-time", text: `${this.formatTime(ev.startTime)} \u2013 ${this.formatTime(ev.endTime)}` });
			item.createEl("span", { cls: "cortex-event-summary", text: ev.summary });
			if (ev.htmlLink) { const a = item.createEl("a", { cls: "cortex-event-link", text: "\u2197", href: ev.htmlLink }); a.setAttr("target", "_blank"); a.setAttr("title", "Open in Google Calendar"); }
		}
	}

	private renderDueReviews(): void {
		const targetDate = this.currentReviewsDate;
		const dueNotes = this.getDueNotes(targetDate);
		this.reviewsContainer.empty();

		const hr = this.reviewsContainer.createDiv({ cls: "cortex-dashboard-header-row" });
		hr.style.display = "flex"; hr.style.justifyContent = "space-between"; hr.style.alignItems = "center"; hr.style.marginBottom = "10px";
		const header = hr.createEl("h2", { text: "" }); header.style.margin = "0";

		const nav = this.createDateNav(hr,
			() => { const d = new Date(this.currentReviewsDate); d.setDate(d.getDate() - 1); this.currentReviewsDate = d; this.renderDueReviews(); },
			() => { this.currentReviewsDate = startOfLocalDay(new Date()); this.renderDueReviews(); },
			() => { const d = new Date(this.currentReviewsDate); d.setDate(d.getDate() + 1); this.currentReviewsDate = d; this.renderDueReviews(); },
		);

		const fb = nav.createEl("button", { cls: "cortex-date-nav-btn cortex-filter-btn" });
		setIcon(fb, "filter");
		fb.addEventListener("click", () => {
			new ReviewFilterModal(this.app, this.reviewFilters, this.testService.getAllTests(), (f) => { this.reviewFilters = f; this.renderDueReviews(); }).open();
		});

		let filtered = dueNotes;
		if (this.reviewFilters.selectedTestIds.size > 0) {
			filtered = dueNotes.filter((note) => {
				for (const t of this.testService.getAllTests()) {
					if (this.reviewFilters.selectedTestIds.has(t.id) && t.filePaths.includes(note.file.path)) return true;
				}
				return false;
			});
		}

		const titleStr = isSameLocalDay(targetDate, new Date()) ? `Due Reviews (${filtered.length})` : `${targetDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })} Reviews (${filtered.length})`;
		header.setText(titleStr);

		if (filtered.length === 0) { this.reviewsContainer.createDiv({ cls: "cortex-reviews-placeholder", text: "No reviews due for this day." }); return; }

		if (this.reviewFilters.sortOrder === "low-to-high") {
			filtered.sort((a, b) => {
				const sa = this.getDueNoteScore(a.file), sb = this.getDueNoteScore(b.file);
				if (sa === null && sb !== null) return -1;
				if (sa !== null && sb === null) return 1;
				if (sa !== null && sb !== null && sa !== sb) return sa - sb;
				return a.nextReview.getTime() - b.nextReview.getTime();
			});
		} else {
			filtered.sort((a, b) => {
				const sa = this.getDueNoteScore(a.file), sb = this.getDueNoteScore(b.file);
				if (sa === null && sb !== null) return 1;
				if (sa !== null && sb === null) return -1;
				if (sa !== null && sb !== null && sa !== sb) return sb - sa;
				return a.nextReview.getTime() - b.nextReview.getTime();
			});
		}

		const list = this.reviewsContainer.createEl("ul", { cls: "cortex-due-list" });
		for (const { file, nextReview, isOverdue } of filtered) {
			const li = list.createEl("li", { cls: "cortex-due-item" });
			if (isOverdue) li.addClasses(["cortex-overdue"]);
			if (isOverdue) li.createEl("span", { cls: "cortex-badge cortex-overdue-badge", text: "overdue" });
			const link = li.createEl("a", { cls: "cortex-note-link", text: file.basename });
			link.addEventListener("click", async (e) => { e.preventDefault(); await this.app.workspace.getLeaf("tab").openFile(file); });
			li.createSpan({ cls: "cortex-note-date", text: nextReview.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) });
		}
	}

	private renderUpcomingTests(): void {
		this.testsContainer.empty();
		const tests = this.testService.getAllTests();
		const active = tests.filter(t => !t.done);
		const sorted = [...active].sort((a, b) => { const da = parseLocalDate(a.date); const db = parseLocalDate(b.date); if (!da || !db) return 0; return da.getTime() - db.getTime(); });

		const hr = this.testsContainer.createDiv({ cls: "cortex-tests-header" });
		hr.createEl("h2", { text: `Upcoming Tests (${sorted.length})` });
		const cbtn = hr.createEl("button", { cls: "cortex-create-test-btn" });
		setIcon(cbtn, "plus");
		cbtn.addEventListener("click", () => { new CreateTestModal(this.app, this.plugin, () => this.renderTests()).open(); });

		if (sorted.length === 0) { this.testsContainer.createDiv({ cls: "cortex-tests-placeholder", text: "No upcoming tests. Click + to create one." }); return; }

		const list = this.testsContainer.createEl("div", { cls: "cortex-test-list" });
		for (const t of sorted) list.appendChild(this.renderTestItem(t));
	}

	private renderTestItem(test: CortexTest): HTMLElement {
		const item = document.createElement("div"); item.className = "cortex-test-item";
		if (test.done) item.addClass("cortex-test-done");
		const hr = item.createDiv({ cls: "cortex-test-header" });
		const icon = hr.createDiv({ cls: "cortex-expand-icon" }); setIcon(icon, "chevron-right");
		hr.createEl("span", { cls: "cortex-test-name", text: test.name });

		const doneBtn = hr.createEl("button", { cls: "cortex-done-btn" + (test.done ? " is-done" : ""), attr: { title: test.done ? "Mark as not done" : "Mark as done" } });
		setIcon(doneBtn, test.done ? "check-circle" : "circle");
		doneBtn.addEventListener("click", async (e) => { e.stopPropagation(); await this.testService.toggleDone(test.id); this.renderTests(); this.renderReviews(); });

		const d = parseLocalDate(test.date) || startOfLocalDay(new Date());
		const ds = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
		const dif = (moment as unknown as (input?: unknown) => { diff(other: unknown, unit: string): number })(test.date).diff((moment as unknown as (input?: unknown) => { startOf(unit: string): unknown })().startOf("day"), "days");
		const dl = dif < 0 ? " (past)" : dif === 0 ? " (today)" : dif === 1 ? " (tomorrow)" : ` (in ${dif} days)`;
		hr.createEl("span", { cls: "cortex-test-date", text: `${ds}${dl}` });

		const det = item.createDiv({ cls: "cortex-test-details" });
		const pg = this.calculateTestProgress(test);
		const pc = det.createDiv({ cls: "cortex-test-progress-container" });
		const pb = pc.createDiv({ cls: "cortex-test-progress-bar" });
		pb.createDiv({ cls: "cortex-test-progress-fill" }).style.width = `${pg}%`;
		pc.createEl("span", { cls: "cortex-test-progress-label", text: `${Math.round(pg)}% prepared` });

		const nl = det.createEl("ul", { cls: "cortex-test-notes-list" });
		for (const fp of test.filePaths) {
			const file = this.app.vault.getFileByPath(fp); if (!file) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			const excl = fm?.exclude_from_exam === true;

			const li = nl.createEl("li", { cls: "cortex-test-note-item" });
			if (excl) li.addClass("excluded");

			const link = li.createEl("a", { cls: "cortex-test-note-link", text: file.basename });
			link.addEventListener("click", async (e) => { e.preventDefault(); await this.app.workspace.getLeaf("tab").openFile(file); });

			const ss = li.createEl("span", { cls: "cortex-test-note-score" });
			if (fm?.confidence !== undefined && fm?.confidence !== null) { ss.addClass("has-score"); ss.setText(`Score: ${fm.confidence}/5`); }
			else { ss.addClass("no-score"); ss.setText("No score"); }

			const exb = li.createEl("button", { cls: "cortex-exclude-btn" + (excl ? " excluded" : ""), text: excl ? "Excluded" : "Exclude" });
			exb.addEventListener("click", async (e) => { e.stopPropagation(); await this.toggleExcl(file, excl); this.renderTests(); });
			li.appendChild(link); li.appendChild(ss); li.appendChild(exb);
		}

		const dbtn = item.createEl("button", { cls: "cortex-test-delete-btn" });
		setIcon(dbtn, "trash");
		dbtn.addEventListener("click", async (e) => { e.stopPropagation(); if (confirm(`Delete "${test.name}"?`)) { await this.testService.removeTest(test.id); this.renderTests(); this.renderReviews(); } });

		item.addEventListener("click", (e) => {
			const el = e.target as HTMLElement;
			if (el.closest(".cortex-test-delete-btn") || el.closest(".cortex-exclude-btn") || el.closest(".cortex-done-btn")) return;
			item.classList.toggle("expanded");
		});

		return item;
	}

	private async toggleExcl(file: TFile, excl: boolean): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => { if (excl) delete fm["exclude_from_exam"]; else fm["exclude_from_exam"] = true; });
	}

	private calculateTestProgress(test: CortexTest): number {
		const MAX = 5; let sum = 0, count = 0;
		for (const fp of test.filePaths) {
			const f = this.app.vault.getFileByPath(fp); if (!f) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (!fm) { count++; continue; }
			if (fm.exclude_from_exam === true || fm.exclude_from_exam === "true") continue;
			count++;
			if (fm.confidence !== undefined && fm.confidence !== null) sum += Math.max(0, Math.min(MAX, Number(fm.confidence) || 0));
		}
		const max = count * MAX;
		return max === 0 ? 0 : (sum / max) * 100;
	}

	// ── Helpers ──────────────────────────────────────────────────────

	private createDateNav(
		parent: HTMLElement,
		onPrev: () => void,
		onToday: () => void,
		onNext: () => void,
	): HTMLElement {
		const nav = parent.createDiv({ cls: "cortex-date-nav" });
		const pb = nav.createEl("button", { cls: "cortex-date-nav-btn", text: "←" });
		pb.addEventListener("click", onPrev);
		const tb = nav.createEl("button", { cls: "cortex-date-nav-btn cortex-date-nav-today-btn", text: "Today" });
		tb.addEventListener("click", onToday);
		const nb = nav.createEl("button", { cls: "cortex-date-nav-btn", text: "→" });
		nb.addEventListener("click", onNext);
		return nav;
	}

	private formatTime(d: Date): string { return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }

	private getDueNotes(target: Date): DueNote[] {
		const ts = startOfLocalDay(target);
		const donePaths = new Set<string>();
		for (const t of this.plugin.settings.tests) {
			if (t.done) {
				for (const fp of t.filePaths) donePaths.add(fp);
			}
		}
		const r: DueNote[] = [];
		const today = startOfLocalDay(new Date());
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (donePaths.has(f.path)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (!fm) continue;
			const examDate = this.parseFrontmatterDate(fm.exam_date);
			if (examDate && examDate < today) continue;
			const pd = this.parseFrontmatterDate(fm.next_review);
			if (pd && pd <= ts) r.push({ file: f, nextReview: pd, isOverdue: pd < ts });
		}
		return r;
	}

	private parseFrontmatterDate(raw: unknown): Date | null {
		if (raw instanceof Date) return startOfLocalDay(raw);
		if (typeof raw === "number") return startOfLocalDay(new Date(raw));
		if (typeof raw === "string") return parseLocalDate(raw);
		return null;
	}

	private getDueNoteScore(f: TFile): number | null {
		const raw = this.app.metadataCache.getFileCache(f)?.frontmatter?.confidence;
		if (raw === undefined || raw === null) return null;
		const v = Number(raw); if (!Number.isFinite(v)) return null;
		return Math.max(1, Math.min(5, v));
	}

}
