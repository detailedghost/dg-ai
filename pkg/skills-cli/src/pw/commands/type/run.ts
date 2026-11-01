import type { DaemonHandler } from "../../core/spec";

const typeText: DaemonHandler = async (ctx, args) => {
	const text = args.positionals[0] as string;
	const page = ctx.page();
	await page.keyboard.type(text);
	const lines = [`await page.keyboard.type(${JSON.stringify(text)});`];
	if (args.flags["submit"] === true) {
		await page.keyboard.press("Enter");
		lines.push(`await page.keyboard.press("Enter");`);
	}
	return { code: lines.join("\n"), snapshot: true };
};

export default typeText;
