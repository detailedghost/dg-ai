import type { Cookie } from "playwright-core";
import { stringFlag, UsageError } from "../../core/args";
import type { DaemonHandler } from "../../core/spec";

const SAME_SITE = ["Strict", "Lax", "None"] as const;

const cookieSet: DaemonHandler = async (ctx, args) => {
	const [name, value] = args.positionals as [string, string];
	const expires = stringFlag(args, "expires");
	const sameSite = stringFlag(args, "sameSite");
	if (expires !== undefined && !/^\d+$/.test(expires)) {
		throw new UsageError(`Invalid --expires '${expires}': use a unix timestamp in seconds`);
	}
	const site = SAME_SITE.find((candidate) => candidate === sameSite);
	if (sameSite !== undefined && !site) {
		throw new UsageError(`Invalid --sameSite '${sameSite}': use ${SAME_SITE.join(", ")}`);
	}
	const cookie: Cookie = {
		name,
		value,
		domain: stringFlag(args, "domain") ?? new URL(ctx.page().url()).hostname,
		path: stringFlag(args, "path") ?? "/",
		expires: expires === undefined ? -1 : Number(expires),
		httpOnly: args.flags["httpOnly"] === true,
		secure: args.flags["secure"] === true,
		sameSite: site ?? "Lax",
	};
	await ctx.context.addCookies([cookie]);
	return {
		code: `await page.context().addCookies([${JSON.stringify(cookie)}]);`,
	};
};

export default cookieSet;
