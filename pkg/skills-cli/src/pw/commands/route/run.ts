import { stringFlag } from "../../core/args";
import { addRoute, buildRoute } from "../../core/routes";
import type { DaemonHandler } from "../../core/spec";

const route: DaemonHandler = async (ctx, args) => {
	const pattern = args.positionals[0] as string;
	const entry = buildRoute({
		pattern,
		status: stringFlag(args, "status"),
		body: stringFlag(args, "body"),
		contentType: stringFlag(args, "content-type"),
		header: stringFlag(args, "header"),
		removeHeader: stringFlag(args, "remove-header"),
	});
	await addRoute(ctx, entry);
	return {
		result: `Route added for pattern: ${pattern}`,
		code: `await page.context().route(${JSON.stringify(pattern)}, async route => { /* route handler */ });`,
	};
};

export default route;
