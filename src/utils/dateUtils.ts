/**
 * Local-date utilities — all functions operate on the local timezone, never UTC.
 * YYYY-MM-DD strings always represent the local calendar day.
 */

export function localISODate(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function parseLocalDate(str: string): Date | null {
	const s = str.trim();
	if (!s) return null;

	// DD.MM.YYYY
	let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
	if (m) {
		const d = Number(m[1]);
		const month = Number(m[2]) - 1;
		const year = Number(m[3]);
		const date = new Date(year, month, d);
		if (
			date.getFullYear() === year &&
			date.getMonth() === month &&
			date.getDate() === d
		) {
			return date;
		}
		return null;
	}

	// YYYY-MM-DD
	m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (m) {
		const year = Number(m[1]);
		const month = Number(m[2]) - 1;
		const d = Number(m[3]);
		const date = new Date(year, month, d);
		if (
			date.getFullYear() === year &&
			date.getMonth() === month &&
			date.getDate() === d
		) {
			return date;
		}
		return null;
	}

	return null;
}

export function addDays(date: Date, days: number): Date {
	const result = startOfLocalDay(date);
	result.setDate(result.getDate() + days);
	return result;
}

export function daysUntil(from: Date, to: Date): number {
	const fromMidnight = startOfLocalDay(from);
	const toMidnight = startOfLocalDay(to);
	return Math.round(
		(toMidnight.getTime() - fromMidnight.getTime()) / (1000 * 60 * 60 * 24),
	);
}

export function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isSameLocalDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}
