import type { DaemonHandler } from "../../core/spec";
import { locatorCode, resolveTarget } from "../../core/targets";

const fill: DaemonHandler = async (ctx, args) => {
	const text = args.positionals[1] as string;
	const locator = await resolveTarget(
		ctx.page(),
		args.positionals[0] as string,
	);
	await locator.fill(text);
	const lines = [
		`await ${locatorCode(locator)}.fill(${JSON.stringify(text)});`,
	];
	if (args.flags["submit"] === true) {
		await locator.press("Enter");
		lines.push(`await ${locatorCode(locator)}.press("Enter");`);
	}
	return { code: lines.join("\n"), snapshot: true };
};

export default fill;
