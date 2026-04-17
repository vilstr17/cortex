import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon, moment } from "obsidian";
import CortexPlugin from "../main";
import { GoogleCalendarService, DisplayCalendarEvent } from "../services/googleCalendarService";
import { CortexChatModal } from "../modals/CortexChatModal";
import { CreateTestModal } from "../modals/CreateTestModal";
import { TestService } from "../services/testService";
import { CortexTest } from "../settings";

export const CORTEX_DASHBOARD_VIEW = "cortex-dashboard";

interface DueNote {
	file: TFile;
	nextReview: Date;
	isOverdue: boolean;
}

export class CortexDashboardView extends ItemView {
	private plugin: CortexPlugin;
	private reviewsContainer!: HTMLElement;
	private scheduleContainer!: HTMLElement;
	private authContainer!: HTMLElement;
	private testsContainer!: HTMLElement;
	private testService!: TestService;

	constructor(leaf: WorkspaceLeaf, plugin: CortexPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CORTEX_DASHBOARD_VIEW;
	}

	getDisplayText(): string {
		return "Cortex Dashboard";
	}

	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();

		this.testService = new TestService(this.plugin);

		const wrapper = container.createDiv({ cls: "cortex-dashboard" });

		// ── 1. Header row: title + chat icon + refresh ──
		const headerRow = wrapper.createDiv({ cls: "cortex-header-row" });
		headerRow.createEl("h1", { text: "Cortex Command Center" });

		// Sleek chat icon button → Gemini Planner
		const chatBtn = headerRow.createEl("button", {
			cls: "cortex-chat-icon-btn",
		});
		chatBtn.setAttr("title", "Open Gemini Planner");
		setIcon(chatBtn, "message-square");
		chatBtn.addEventListener("click", () => {
			if (!this.plugin.settings.geminiApiKey) {
				new Notice("Cortex: Please set your Gemini API key in Settings → Cortex first.");
				return;
			}
			new CortexChatModal(this.app, this.plugin).open();
		});

		// Refresh button
		const refreshBtn = headerRow.createEl("button", {
			cls: "cortex-refresh-btn clickable-icon",
		});
		refreshBtn.setAttr("title", "Refresh");
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => this.render());

		// ── 2. Due Reviews (middle-top) ──
		this.reviewsContainer = wrapper.createDiv({
			cls: "cortex-reviews-section",
		});

		// ── 3. Today's Schedule (middle-bottom) ──
		this.scheduleContainer = wrapper.createDiv({ cls: "cortex-schedule-section" });

		// ── 4. Upcoming Tests ──
		this.testsContainer = wrapper.createDiv({ cls: "cortex-tests-section" });

		// ── 5. Google Calendar auth (shown only when not connected) ──
		this.authContainer = wrapper.createDiv({ cls: "cortex-auth-section" });

		// Listen for frontmatter changes to auto-refresh
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.render();
				}
			}),
		);

		this.render();
	}

	async onClose(): Promise<void> {
		// all listeners registered via registerEvent are cleaned up automatically
	}

	private async render(): Promise<void> {
		this.renderGoogleCalendarSection();
		this.renderDueReviews();
		this.renderUpcomingTests();
	}

	// ── Google Calendar ──────────────────────────────────────────────

	private renderGoogleCalendarSection(): void {
		this.authContainer.empty();
		this.scheduleContainer.empty();

		if (!this.plugin.settings.googleAccessToken) {
			this.renderConnectButton();
			return;
		}

		// Token exists — fetch and show today's events
		this.renderTodaysSchedule();
	}

	private renderConnectButton(): void {
		this.authContainer.createEl("p", {
			text: "Connect your Google Calendar to see today's schedule alongside your reviews.",
			cls: "cortex-calendar-connect-desc",
		});

		const btn = this.authContainer.createEl("button", {
			cls: "cortex-connect-google-btn",
			text: "Connect Google Calendar",
		});

		btn.addEventListener("click", async () => {
			await this.handleConnectGoogleCalendar();
		});
	}

	private async handleConnectGoogleCalendar(): Promise<void> {
		const calendarService = new GoogleCalendarService(
			this.plugin.settings,
			() => this.plugin.saveData(this.plugin.settings),
		);

		try {
			const authResponse = await calendarService.initiateDeviceAuth();

			// Show the user code and verification URL in the UI
			this.authContainer.empty();

			const statusEl = this.authContainer.createDiv({ cls: "cortex-auth-status" });
			statusEl.createEl("h4", { text: "Connect Google Calendar" });

			const hintEl = statusEl.createEl("p", {
				text: "Click the link below, enter your code, and grant access.",
				cls: "cortex-auth-hint",
			});
			hintEl.style.color = "var(--text-muted)";
			hintEl.style.fontSize = "0.85em";

			const linkEl = statusEl.createEl("a", {
				cls: "cortex-auth-link",
				text: authResponse.verification_url ?? authResponse.verification_uri,
				href: authResponse.verification_url ?? authResponse.verification_uri,
			});
			linkEl.setAttr("target", "_blank");
			linkEl.style.display = "block";
			linkEl.style.margin = "8px 0";
			linkEl.style.wordBreak = "break-all";

			const codeEl = statusEl.createDiv({ cls: "cortex-auth-code" });
			codeEl.createSpan({ text: "Your code: " });
			const codeSpan = codeEl.createSpan({
				cls: "cortex-auth-code-value",
				text: authResponse.user_code,
			});
			codeSpan.style.fontWeight = "bold";
			codeSpan.style.fontSize = "1.4em";
			codeSpan.style.letterSpacing = "0.1em";

			const pollingEl = statusEl.createEl("p", {
				text: "Waiting for authorization…",
				cls: "cortex-auth-polling",
			});

			// Start polling for tokens
			const success = await calendarService.pollForTokens(
				authResponse.device_code,
				authResponse.interval,
				authResponse.expires_in,
			);

			if (success) {
				pollingEl.setText("✓ Google Calendar connected!");
				new Notice("Cortex: Google Calendar connected successfully.");
				// Re-render to show today's schedule
				this.renderGoogleCalendarSection();
			} else {
				pollingEl.setText("Authorization timed out. Please try again.");
				pollingEl.style.color = "var(--text-error)";
				// Revert to connect button after a delay
				setTimeout(() => this.renderGoogleCalendarSection(), 5000);
			}
		} catch (err) {
			console.error("Cortex: Failed to initiate device auth:", err);
			new Notice("Cortex: Failed to start Google Calendar authentication.");
		}
	}

	private async renderTodaysSchedule(): Promise<void> {
		const calendarService = new GoogleCalendarService(
			this.plugin.settings,
			() => this.plugin.saveData(this.plugin.settings),
		);

		const today = new Date();
		const events = await calendarService.getEventsForDay(today);

		this.scheduleContainer.empty();

		if (events.length === 0) {
			this.scheduleContainer.createEl("h2", { text: "Today's Schedule" });
			this.scheduleContainer.createDiv({
				cls: "cortex-schedule-placeholder",
				text: "No events scheduled today.",
			});
			return;
		}

		// Section header with count
		this.scheduleContainer.createEl("h2", {
			text: `Today's Schedule (${events.length})`,
		});

		const list = this.scheduleContainer.createEl("div", {
			cls: "cortex-event-list",
		});

		// Events are already sorted by startTime from the API
		for (const event of events) {
			const item = list.createDiv({ cls: "cortex-event-item" });

			// Time range
			const timeStr = `${this.formatTime(event.startTime)} – ${this.formatTime(event.endTime)}`;
			item.createEl("span", {
				cls: "cortex-event-time",
				text: timeStr,
			});

			// Event summary
			const summaryEl = item.createEl("span", {
				cls: "cortex-event-summary",
				text: event.summary,
			});

			// Optional link to event in Google Calendar
			if (event.htmlLink) {
				const link = item.createEl("a", {
					cls: "cortex-event-link",
					text: "↗",
					href: event.htmlLink,
				});
				link.setAttr("target", "_blank");
				link.setAttr("title", "Open in Google Calendar");
			}
		}
	}

	// ── Due Reviews ──────────────────────────────────────────────────

	private renderDueReviews(): void {
		const dueNotes = this.getDueNotes();
		this.reviewsContainer.empty();

		// Section header with count
		const header = this.reviewsContainer.createEl("h2", {
			text: `Due Reviews (${dueNotes.length})`,
		});
		header.style.marginTop = "0";

		if (dueNotes.length === 0) {
			this.reviewsContainer.createDiv({
				cls: "cortex-reviews-placeholder",
				text: "No reviews due. You're all caught up!",
			});
			return;
		}

		// Sort: overdue first (oldest first), then today's
		dueNotes.sort((a, b) => a.nextReview.getTime() - b.nextReview.getTime());

		const list = this.reviewsContainer.createEl("ul", {
			cls: "cortex-due-list",
		});

		for (const { file, nextReview, isOverdue } of dueNotes) {
			const li = list.createEl("li", {
				cls: "cortex-due-item",
			});
			if (isOverdue) {
				li.addClasses(["cortex-overdue"]);
			}

			// Overdue badge
			if (isOverdue) {
				li.createEl("span", {
					cls: "cortex-badge cortex-overdue-badge",
					text: "overdue",
				});
			}

			// Clickable title
			const link = li.createEl("a", {
				cls: "cortex-note-link",
				text: file.basename,
			});
			link.addEventListener("click", async (e) => {
				e.preventDefault();
				const leaf = this.app.workspace.getLeaf("tab");
				await leaf.openFile(file);
			});

			// Date label
			const dateStr = nextReview.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
			li.createSpan({
				cls: "cortex-note-date",
				text: dateStr,
			});
		}
	}

	// ── Upcoming Tests ───────────────────────────────────────────────

	private renderUpcomingTests(): void {
		this.testsContainer.empty();

		const tests = this.testService.getAllTests();

		// Sort tests by date (earliest first)
		const sortedTests = [...tests].sort((a, b) => {
			return new Date(a.date).getTime() - new Date(b.date).getTime();
		});

		// Section header with count and create button
		const headerRow = this.testsContainer.createDiv({ cls: "cortex-tests-header" });
		headerRow.createEl("h2", {
			text: `Upcoming Tests (${sortedTests.length})`,
		});

		const createBtn = headerRow.createEl("button", {
			cls: "cortex-create-test-btn",
		});
		createBtn.setAttr("title", "Create New Test");
		setIcon(createBtn, "plus");
		createBtn.addEventListener("click", () => {
			new CreateTestModal(this.app, this.plugin, () => this.render()).open();
		});

		if (sortedTests.length === 0) {
			this.testsContainer.createDiv({
				cls: "cortex-tests-placeholder",
				text: "No upcoming tests. Click + to create one.",
			});
			return;
		}

		const list = this.testsContainer.createEl("div", {
			cls: "cortex-test-list",
		});

		for (const test of sortedTests) {
			const testItem = this.renderTestItem(test);
			list.appendChild(testItem);
		}
	}

	private renderTestItem(test: CortexTest): HTMLElement {
		const item = document.createElement("div");
		item.className = "cortex-test-item";

		// Header row (clickable for expand/collapse)
		const headerRow = item.createDiv({ cls: "cortex-test-header" });

		// Expand icon
		const expandIcon = headerRow.createDiv({ cls: "cortex-expand-icon" });
		setIcon(expandIcon, "chevron-right");

		// Test name
		headerRow.createEl("span", {
			cls: "cortex-test-name",
			text: test.name,
		});

		const testDate = new Date(test.date);
		const dateStr = testDate.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});

		// Calculate days until test
		const today = moment().startOf("day");
		const testDay = moment(test.date);
		const daysUntil = testDay.diff(today, "days");

		let daysLabel = "";
		if (daysUntil < 0) {
			daysLabel = " (past)";
		} else if (daysUntil === 0) {
			daysLabel = " (today)";
		} else if (daysUntil === 1) {
			daysLabel = " (tomorrow)";
		} else {
			daysLabel = ` (in ${daysUntil} days)`;
		}

		headerRow.createEl("span", {
			cls: "cortex-test-date",
			text: `${dateStr}${daysLabel}`,
		});

		// Details section (hidden by default)
		const details = item.createDiv({ cls: "cortex-test-details" });

		// Progress bar
		const progress = this.calculateTestProgress(test);
		const progressContainer = details.createDiv({ cls: "cortex-test-progress-container" });

		const progressBar = progressContainer.createDiv({ cls: "cortex-test-progress-bar" });
		const progressFill = progressBar.createDiv({ cls: "cortex-test-progress-fill" });
		progressFill.style.width = `${progress}%`;
		progressContainer.createEl("span", {
			cls: "cortex-test-progress-label",
			text: `${Math.round(progress)}% prepared`,
		});

		// Notes list
		const notesList = details.createEl("ul", { cls: "cortex-test-notes-list" });

		for (const filePath of test.filePaths) {
			const file = this.app.vault.getFileByPath(filePath);
			if (!file) continue;

			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter;
			const excludeFromExam = frontmatter?.exclude_from_exam === true;
			const confidence = frontmatter?.confidence;

			const li = notesList.createEl("li", { cls: "cortex-test-note-item" });
			if (excludeFromExam) {
				li.addClass("excluded");
			}

			// Note link
			const link = li.createEl("a", { cls: "cortex-test-note-link", text: file.basename });
			link.addEventListener("click", async (e) => {
				e.preventDefault();
				const leaf = this.app.workspace.getLeaf("tab");
				await leaf.openFile(file);
			});

			// Score display
			const scoreSpan = li.createEl("span", { cls: "cortex-test-note-score" });
			if (confidence !== undefined && confidence !== null) {
				scoreSpan.addClass("has-score");
				scoreSpan.setText(`Score: ${confidence}/5`);
			} else {
				scoreSpan.addClass("no-score");
				scoreSpan.setText("No score");
			}

			// Exclude button
			const excludeBtn = li.createEl("button", {
				cls: "cortex-exclude-btn" + (excludeFromExam ? " excluded" : ""),
				text: excludeFromExam ? "Excluded" : "Exclude",
			});
			excludeBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				await this.toggleExcludeFromExam(file, excludeFromExam);
				this.render();
			});

			li.appendChild(link);
			li.appendChild(scoreSpan);
			li.appendChild(excludeBtn);
		}

		// Delete button (in header area)
		const deleteBtn = item.createEl("button", {
			cls: "cortex-test-delete-btn",
		});
		setIcon(deleteBtn, "trash");
		deleteBtn.setAttr("title", "Delete test");
		deleteBtn.addEventListener("click", async (e) => {
			e.stopPropagation();
			if (confirm(`Delete test "${test.name}"?`)) {
				await this.testService.removeTest(test.id);
				this.render();
			}
		});

		// Click handler for expand/collapse
		item.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			// Don't toggle if clicking on delete button or exclude button
			if (target.closest(".cortex-test-delete-btn") || target.closest(".cortex-exclude-btn")) {
				return;
			}
			item.classList.toggle("expanded");
		});

		return item;
	}

	private async toggleExcludeFromExam(file: TFile, currentlyExcluded: boolean): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			if (currentlyExcluded) {
				// Remove the flag
				delete frontmatter["exclude_from_exam"];
			} else {
				// Add the flag
				frontmatter["exclude_from_exam"] = true;
			}
		});
	}

	/**
	 * Calculate progress for a test based on confidence scores of ALL associated files.
	 *
	 * Formula:
	 * Total Progress = (Sum of all scores) / (Total number of linked notes × Max Score)
	 *
	 * Any note linked to the exam that does NOT have a logged study session yet
	 * is automatically treated as having a score/confidence of 0.
	 *
	 * This means unlogged notes drag the total percentage down to reflect the
	 * actual reality of unstudied material.
	 *
	 * Max score per note = 5 (matching the 1-5 review scale in srsLogic.ts).
	 */
	private calculateTestProgress(test: CortexTest): number {
		const MAX_SCORE = 5;
		let totalScoreSum = 0;
		let validNotesCount = 0;

		for (const filePath of test.filePaths) {
			const file = this.app.vault.getFileByPath(filePath);
			if (!file) {
				// File not found in vault — skip it
				continue;
			}

			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter;

			if (!frontmatter) {
				// No frontmatter at all — treat as score 0 (unstudied)
				validNotesCount++;
				continue;
			}

			// Skip notes explicitly excluded from the exam
			if (frontmatter.exclude_from_exam === true || frontmatter.exclude_from_exam === "true") {
				continue;
			}

			validNotesCount++;

			const confidence = frontmatter.confidence;
			// If confidence is undefined or null, this note has never been reviewed — score = 0
			if (confidence === undefined || confidence === null) {
				continue; // totalScoreSum += 0
			}

			// Clamp to valid range just in case
			const score = Math.max(0, Math.min(MAX_SCORE, Number(confidence) || 0));
			totalScoreSum += score;
		}

		const maxPossibleScore = validNotesCount * MAX_SCORE;
		if (maxPossibleScore === 0) {
			return 0;
		}

		return (totalScoreSum / maxPossibleScore) * 100;
	}

	// ── Helpers ──────────────────────────────────────────────────────

	private formatTime(date: Date): string {
		return date.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	/**
	 * Scan the vault for markdown files whose next_review date is today or earlier.
	 * Supports both YYYY-MM-DD and DD.MM.YYYY formats.
	 */
	private getDueNotes(): DueNote[] {
		const today = this.getStartOfToday();
		const dueNotes: DueNote[] = [];

		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter;
			if (!frontmatter) continue;

			const rawDate = frontmatter.next_review;
			if (rawDate === undefined || rawDate === null) continue;

			const parsedDate = this.parseDate(rawDate);
			if (!parsedDate) continue;

			// Due if next_review is today or in the past
			if (parsedDate <= today) {
				dueNotes.push({
					file,
					nextReview: parsedDate,
					isOverdue: parsedDate < today,
				});
			}
		}

		return dueNotes;
	}

	/**
	 * Parse a date string that may be in YYYY-MM-DD or DD.MM.YYYY format.
	 * Returns the start of that day (midnight), or null if unparseable.
	 */
	private parseDate(raw: unknown): Date | null {
		if (raw instanceof Date) {
			return this.startOfDay(raw);
		}

		if (typeof raw === "number") {
			return this.startOfDay(new Date(raw));
		}

		if (typeof raw !== "string") return null;

		const trimmed = raw.trim();
		if (!trimmed) return null;

		// Try DD.MM.YYYY
		const ddMmYyyy = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
		if (ddMmYyyy) {
			const day = parseInt(ddMmYyyy[1], 10);
			const month = parseInt(ddMmYyyy[2], 10) - 1; // JS months are 0-indexed
			const year = parseInt(ddMmYyyy[3], 10);
			const d = new Date(year, month, day);
			if (d.getFullYear() === year && d.getMonth() === month && d.getDate() === day) {
				return d;
			}
			return null; // invalid date
		}

		// Try YYYY-MM-DD
		const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
		if (yyyyMmDd) {
			const year = parseInt(yyyyMmDd[1], 10);
			const month = parseInt(yyyyMmDd[2], 10) - 1;
			const day = parseInt(yyyyMmDd[3], 10);
			const d = new Date(year, month, day);
			if (d.getFullYear() === year && d.getMonth() === month && d.getDate() === day) {
				return d;
			}
			return null;
		}

		// Fallback: try native Date.parse
		const fallback = new Date(trimmed);
		if (!isNaN(fallback.getTime())) {
			return this.startOfDay(fallback);
		}

		return null;
	}

	private getStartOfToday(): Date {
		const now = new Date();
		return new Date(now.getFullYear(), now.getMonth(), now.getDate());
	}

	private startOfDay(d: Date): Date {
		return new Date(d.getFullYear(), d.getMonth(), d.getDate());
	}
}
