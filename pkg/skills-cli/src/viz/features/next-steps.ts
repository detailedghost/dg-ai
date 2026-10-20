import { existsSync, readFileSync } from "node:fs";
import { sessionUrl } from "../config";
import { die, note } from "../io";
import { ensureServer, openUrlOnce } from "../server";
import { mutatePayload, validateSlug } from "../session";

const USAGE =
	"usage: dg-skills viz next-steps <slug> [--set file|--approve|--comment text]";

function parseSteps(path: string): string[] {
	if (!existsSync(path)) die(`steps file not found: ${path}`);
	const raw = readFileSync(path, "utf-8").trim();
	if (!raw) return [];
	try {
		const json = JSON.parse(raw);
		if (!Array.isArray(json) || !json.every((x) => typeof x === "string")) {
			die("steps file JSON must be an array of strings");
		}
		return json;
	} catch {
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	}
}

export async function cmdNextSteps(rest: string[]): Promise<void> {
	const [rawSlug, ...flags] = rest;
	if (!rawSlug) die(USAGE);
	const slug = validateSlug(rawSlug);

	let setFile: string | undefined;
	let approve = false;
	let comment: string | undefined;
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		if (flag === "--set") setFile = flags[++i];
		else if (flag === "--approve") approve = true;
		else if (flag === "--comment") comment = flags[++i];
		else die(`unknown flag '${flag}'`);
	}

	if (!setFile && !approve && comment === undefined) die(USAGE);

	await mutatePayload(slug, (payload) => {
		if (setFile) {
			payload.next_steps = parseSteps(setFile);
			payload.next_steps_approved = false;
			payload.next_steps_feedback_pending = false;
			payload.all_clear = false;
			if (Array.isArray(payload.next_steps_feedback)) {
				for (const item of payload.next_steps_feedback as Record<
					string,
					unknown
				>[]) {
					item.resolved = true;
				}
			}
		}
		if (approve) {
			payload.next_steps_approved = true;
			payload.next_steps_feedback_pending = false;
			payload.all_clear = true;
		}
		if (comment !== undefined) {
			const text = comment.trim();
			if (!text) throw new Error("--comment requires non-empty text");
			const feedback = Array.isArray(payload.next_steps_feedback)
				? (payload.next_steps_feedback as Record<string, unknown>[])
				: [];
			feedback.push({ comment: text, resolved: false });
			payload.next_steps_feedback = feedback;
			payload.next_steps_approved = false;
			payload.next_steps_feedback_pending = true;
			payload.all_clear = false;
		}
	});

	await ensureServer();
	openUrlOnce(slug, sessionUrl(slug));
	note(`next steps updated -> ${sessionUrl(slug)}`);
}
