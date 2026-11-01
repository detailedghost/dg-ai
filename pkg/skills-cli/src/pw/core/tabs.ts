import type { Page } from "playwright-core";
import type { Ctx } from "./spec";

export async function listTabs(ctx: Ctx): Promise<string> {
	const pages = ctx.context.pages();
	if (pages.length === 0) return "No open tabs. Navigate to a URL to create one.";
	let current: Page | undefined;
	try {
		current = ctx.page();
	} catch {
		current = undefined;
	}
	const lines: string[] = [];
	for (const [index, page] of pages.entries()) {
		const title = ctx.events.hasDialog(page) ? "" : await page.title().catch(() => "");
		lines.push(`- ${index}:${page === current ? " (current)" : ""} [${title}](${page.url()})`);
	}
	return lines.join("\n");
}

export function tabIndex(value: string, count: number): number {
	if (!/^\d+$/.test(value) || Number(value) >= count) {
		throw new Error(`Tab ${value} does not exist. Run: pw tab-list`);
	}
	return Number(value);
}
