import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { sessionDir, sessionUrl, vizConfig } from "../config";
import { die, note } from "../io";
import { mintBoardSecurity } from "../respond-core";
import { ensureServer, openUrlOnce } from "../server";
import {
	clearStale,
	detectSessionId,
	namespaceSlug,
	validateSlug,
} from "../session";

const VALID_TEMPLATES = ["plan", "recap", "spec"] as const;

export async function cmdRender(args: string[]): Promise<void> {
	let input = "";
	let noOpen = false;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--input":
				input = args[++i] ?? die("--input requires a value");
				break;
			case "--no-open":
				noOpen = true;
				break;
			case "--keep":
				note(
					"--keep is deprecated and ignored — viz files always live in the temp dir",
				);
				break;
			default:
				die(`unknown argument: ${args[i]}`);
		}
	}

	if (!input) die("usage: dg-skills viz --input <payload.json> [--no-open]");
	if (!existsSync(input)) die(`input file not found: ${input}`);

	const payload = JSON.parse(readFileSync(input, "utf-8")) as {
		template?: string;
		slug?: string;
		session_id?: string;
		_secured?: boolean;
	};
	const { template } = payload;
	const rawSlug = payload.slug;
	if (rawSlug !== undefined && typeof rawSlug !== "string")
		die(`invalid slug: expected a string, got ${typeof rawSlug}`);
	if (
		template !== undefined &&
		!(VALID_TEMPLATES as readonly string[]).includes(template)
	)
		die(
			`unknown template "${template}" (expected one of: ${VALID_TEMPLATES.join(", ")})`,
		);
	if (!rawSlug) die("missing required field: slug");
	validateSlug(rawSlug);
	if (template === undefined) payload.template = "plan";

	const sid = payload.session_id ?? detectSessionId();
	if (sid && !payload.session_id) payload.session_id = sid;

	const finalSlug = namespaceSlug(rawSlug, sid);
	payload.slug = finalSlug;
	payload._secured = true;

	const serialized = JSON.stringify(payload, null, "\t");

	const slugDir = sessionDir(finalSlug);
	mkdirSync(slugDir, { recursive: true });
	chmodSync(slugDir, 0o700);
	writeFileSync(`${slugDir}/payload.json`, serialized);
	clearStale(finalSlug);

	mintBoardSecurity(slugDir, vizConfig().vizDir);

	await ensureServer();
	const url = sessionUrl(finalSlug);
	if (!noOpen) openUrlOnce(finalSlug, url);
	process.stdout.write(`VIZ_URL=${url}\nVIZ_PATH=${slugDir}/payload.json\n`);
	note(url);
}
