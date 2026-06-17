import { App, Modal, Setting } from "obsidian";
import { ChronoteTest } from "../settings.js";

export interface ReviewFilters {
	sortOrder: "low-to-high" | "high-to-low";
	selectedTestIds: Set<string>;
}

export class ReviewFilterModal extends Modal {
	private onApply: (filters: ReviewFilters) => void;
	private currentFilters: ReviewFilters;
	private allTests: ChronoteTest[];

	constructor(
		app: App,
		currentFilters: ReviewFilters,
		allTests: ChronoteTest[],
		onApply: (filters: ReviewFilters) => void
	) {
		super(app);
		this.onApply = onApply;
		this.currentFilters = {
			sortOrder: currentFilters.sortOrder,
			selectedTestIds: new Set(currentFilters.selectedTestIds),
		};
		this.allTests = allTests;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Filter & Sort Reviews" });

		// ── Sort Order ──
		contentEl.createEl("h3", { text: "Sort by score:" });

		const sortContainer = contentEl.createDiv({ cls: "chronote-filter-sort-group" });

		const lowToHighLabel = sortContainer.createEl("label", { cls: "chronote-filter-checkbox" });
		const lowToHighInput = lowToHighLabel.createEl("input", { type: "radio", attr: { name: "sort-order", value: "low-to-high" } });
		lowToHighInput.checked = this.currentFilters.sortOrder === "low-to-high";
		lowToHighInput.addEventListener("change", () => {
			this.currentFilters.sortOrder = "low-to-high";
		});
		lowToHighLabel.createEl("span", { text: "Low to High (unknown first)" });

		const highToLowLabel = sortContainer.createEl("label", { cls: "chronote-filter-checkbox" });
		const highToLowInput = highToLowLabel.createEl("input", { type: "radio", attr: { name: "sort-order", value: "high-to-low" } });
		highToLowInput.checked = this.currentFilters.sortOrder === "high-to-low";
		highToLowInput.addEventListener("change", () => {
			this.currentFilters.sortOrder = "high-to-low";
		});
		highToLowLabel.createEl("span", { text: "High to Low" });

		// ── Test Filter ──
		if (this.allTests.length > 0) {
			contentEl.createEl("h3", { text: "Filter by test:" });

			const testContainer = contentEl.createDiv({ cls: "chronote-filter-test-group" });

			// "All Tests" checkbox
			const allTestsLabel = testContainer.createEl("label", { cls: "chronote-filter-checkbox" });
			const allTestsInput = allTestsLabel.createEl("input", { type: "checkbox", attr: { value: "all" } });
			const allTestsChecked = this.currentFilters.selectedTestIds.size === 0 || this.currentFilters.selectedTestIds.size === this.allTests.length;
			allTestsInput.checked = allTestsChecked;
			allTestsInput.addEventListener("change", () => {
				if (allTestsInput.checked) {
					this.currentFilters.selectedTestIds.clear();
				} else {
					this.currentFilters.selectedTestIds = new Set(this.allTests.map(t => t.id));
				}
				// Re-render checkboxes
				this.onOpen();
			});
			allTestsLabel.createEl("span", { text: "All tests" });

			// Individual test checkboxes
			for (const test of this.allTests) {
				const testLabel = testContainer.createEl("label", { cls: "chronote-filter-checkbox is-indented" });
				const testInput = testLabel.createEl("input", { type: "checkbox", attr: { value: test.id } });
				
				// If selectedTestIds is empty, it means all tests are selected
				const isAllSelected = this.currentFilters.selectedTestIds.size === 0;
				testInput.checked = isAllSelected || this.currentFilters.selectedTestIds.has(test.id);
				
				testInput.addEventListener("change", () => {
					if (testInput.checked) {
						this.currentFilters.selectedTestIds.add(test.id);
					} else {
						this.currentFilters.selectedTestIds.delete(test.id);
					}
				});
				testLabel.createEl("span", { text: test.name });
			}
		}

		// ── Buttons ──
		const buttonContainer = contentEl.createDiv({ cls: "chronote-filter-buttons" });

		const applyBtn = buttonContainer.createEl("button", {
			cls: "chronote-filter-apply-btn",
			text: "Apply",
		});
		applyBtn.addEventListener("click", () => {
			this.onApply(this.currentFilters);
			this.close();
		});

		const cancelBtn = buttonContainer.createEl("button", {
			cls: "chronote-filter-cancel-btn",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => {
			this.close();
		});
	}

	onClose(): void {
		// Cleanup
	}
}
