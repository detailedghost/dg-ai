import { stringFlag } from "../../core/args";
import { formatCookie } from "../../core/cookies";
import type { DaemonHandler } from "../../core/spec";

const cookieList: DaemonHandler = async (ctx, args) => {
	const domain = stringFlag(args, "domain");
	const path = stringFlag(args, "path");
	const cookies = (await ctx.context.cookies()).filter(
		(cookie) => (!domain || cookie.domain.includes(domain)) && (!path || cookie.path.startsWith(path)),
	);
	return {
		result: cookies.length === 0 ? "No cookies found" : cookies.map(formatCookie).join("\n"),
		code: "await page.context().cookies();",
	};
};

export default cookieList;
