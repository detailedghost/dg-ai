import { formatCookieDetail } from "../../core/cookies";
import type { DaemonHandler } from "../../core/spec";

const cookieGet: DaemonHandler = async (ctx, args) => {
	const name = args.positionals[0] as string;
	const cookie = (await ctx.context.cookies()).find(
		(candidate) => candidate.name === name,
	);
	return {
		result: cookie ? formatCookieDetail(cookie) : `Cookie '${name}' not found`,
		code: "await page.context().cookies();",
	};
};

export default cookieGet;
