import type { Page } from "playwright-core";
import { stringFlag, UsageError } from "../../core/args";
import { restrictFile } from "../../core/files";
import { resolveOutput, timestampedName } from "../../core/response";
import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

export const imageType = (filename: string): "png" | "jpeg" => (/\.jpe?g$/i.test(filename) ? "jpeg" : "png");

type ColorScheme = "light" | "dark";

function parseColorScheme(value: string | undefined): ColorScheme | undefined {
	if (value === undefined) return undefined;
	if (value === "light" || value === "dark") return value;
	throw new UsageError(`Invalid --color-scheme '${value}': use light or dark`);
}

async function withColorScheme<T>(page: Page, scheme: ColorScheme | undefined, capture: () => Promise<T>): Promise<T> {
	if (!scheme) return capture();
	await page.emulateMedia({ colorScheme: scheme });
	try {
		return await capture();
	} finally {
		await page.emulateMedia({ colorScheme: null });
	}
}

const screenshot: DaemonHandler = async (ctx, args) => {
	const file = resolveOutput(ctx.outputDir, stringFlag(args, "filename") ?? timestampedName("page", "png"));
	const type = imageType(file);
	const page = ctx.page();
	const scheme = parseColorScheme(stringFlag(args, "color-scheme"));
	const target = args.positionals[0];
	if (target) {
		const locator = await resolveTarget(page, target);
		await withColorScheme(page, scheme, () => locator.screenshot({ path: file, type }));
		restrictFile(file);
		return { result: `- [Screenshot of element](${file})`, code: `await ${locatorCode(locator)}.screenshot();` };
	}
	const fullPage = args.flags["full-page"] === true;
	await withColorScheme(page, scheme, () => page.screenshot({ path: file, type, fullPage }));
	restrictFile(file);
	return {
		result: `- [Screenshot of ${fullPage ? "full page" : "viewport"}](${file})`,
		code: `await page.screenshot(${fullPage ? "{ fullPage: true }" : ""});`,
	};
};

export default screenshot;
