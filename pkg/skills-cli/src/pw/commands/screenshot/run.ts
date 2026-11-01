import { stringFlag } from "../../core/args";
import { restrictFile } from "../../core/files";
import { resolveOutput, timestampedName } from "../../core/response";
import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

export const imageType = (filename: string): "png" | "jpeg" => (/\.jpe?g$/i.test(filename) ? "jpeg" : "png");

const screenshot: DaemonHandler = async (ctx, args) => {
	const file = resolveOutput(ctx.outputDir, stringFlag(args, "filename") ?? timestampedName("page", "png"));
	const type = imageType(file);
	const page = ctx.page();
	const target = args.positionals[0];
	if (target) {
		const locator = await resolveTarget(page, target);
		await locator.screenshot({ path: file, type });
		restrictFile(file);
		return {
			result: `- [Screenshot of element](${file})`,
			code: `await ${locatorCode(locator)}.screenshot();`,
		};
	}
	const fullPage = args.flags["full-page"] === true;
	await page.screenshot({ path: file, type, fullPage });
	restrictFile(file);
	return {
		result: `- [Screenshot of ${fullPage ? "full page" : "viewport"}](${file})`,
		code: `await page.screenshot(${fullPage ? "{ fullPage: true }" : ""});`,
	};
};

export default screenshot;
