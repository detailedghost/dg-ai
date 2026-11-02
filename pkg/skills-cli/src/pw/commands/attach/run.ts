import { stringFlag, UsageError } from "../../core/args";
import type { LaunchSpec } from "../../core/browser";
import { launch, releaseKey } from "../../core/launch";
import { isProtectedSession } from "../../core/protected-session";
import {
	defaultOutputDir,
	list,
	sessionKey,
	socketPathFor,
} from "../../core/registry";
import type { ClientHandler } from "../../core/spec";
import { parseCdpUrl } from "../../core/url";

function parseEndpoint(value: string | undefined): string {
	if (!value) throw new UsageError("attach needs --cdp=<url>");
	return parseCdpUrl(value);
}

const attach: ClientHandler = async (args, env) => {
	const cdpUrl = parseEndpoint(stringFlag(args, "cdp"));
	const port = new URL(cdpUrl).port;
	const guarded = list().find(
		(record) =>
			isProtectedSession(record.name) &&
			record.cdpUrl !== undefined &&
			new URL(record.cdpUrl).port === port,
	);
	if (guarded) {
		env.err(
			`### Error\npw refuses to attach to the ${guarded.name} browser: it holds a signed-in mailbox. Use dg-skills inbox.`,
		);
		return 1;
	}
	const key = sessionKey({ name: args.session, scratch: false });
	const refused = await releaseKey({ key, scratch: false }, env);
	if (refused !== null) return refused;

	const outputDir = defaultOutputDir();
	const spec: LaunchSpec = {
		name: args.session,
		key,
		socketPath: socketPathFor(key),
		cwd: env.cwd,
		outputDir,
		mode: "cdp",
		browser: "chrome",
		headless: false,
		scratch: false,
		codegen: args.codegen,
		profileDir: null,
		cdpUrl,
	};
	return launch(spec, undefined, env);
};

export default attach;
