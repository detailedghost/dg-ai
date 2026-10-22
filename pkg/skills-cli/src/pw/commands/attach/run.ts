import { stringFlag, UsageError } from "../../core/args";
import type { LaunchSpec } from "../../core/browser";
import { launch, releaseKey } from "../../core/launch";
import { defaultOutputDir, sessionKey, socketPathFor } from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

const CDP_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function parseEndpoint(value: string | undefined): string {
	if (!value) throw new UsageError("attach needs --cdp=<url>");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new UsageError(`Invalid --cdp URL '${value}'`);
	}
	if (!CDP_PROTOCOLS.has(url.protocol)) throw new UsageError(`--cdp must be an http(s) or ws(s) URL, got '${value}'`);
	return value;
}

const attach: ClientHandler = async (args, env) => {
	const cdpUrl = parseEndpoint(stringFlag(args, "cdp"));
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
