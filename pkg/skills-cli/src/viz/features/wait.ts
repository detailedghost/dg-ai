import { existsSync, readFileSync } from "node:fs";
import { selfCommand, shellCommand } from "../../utils/self-command";
import { flagValue } from "../args";
import { sessionDir } from "../config";
import { die } from "../io";
import { clearStale, markStale, validateSlug } from "../session";

interface WaitState {
	done: boolean;
	feedback: boolean;
	payload?: Record<string, unknown>;
}

function readWaitState(payloadPath: string): WaitState {
	try {
		const data = JSON.parse(readFileSync(payloadPath, "utf-8")) as Record<
			string,
			unknown
		>;
		return {
			done: data.all_clear === true,
			feedback: data.next_steps_feedback_pending === true,
			payload: data,
		};
	} catch {
		return { done: false, feedback: false };
	}
}

function settled(state: WaitState): boolean {
	if (state.feedback) {
		process.stdout.write(
			`${JSON.stringify(
				{
					all_clear: false,
					next_steps_feedback_pending: true,
					next_steps_feedback: state.payload?.next_steps_feedback ?? [],
				},
				null,
				2,
			)}\n`,
		);
		return true;
	}
	return state.done;
}

/** Block until all_clear flips. */
export async function cmdWait(rest: string[]): Promise<void> {
	const rawSlug = rest[0];
	if (!rawSlug)
		die(
			"usage: dg-skills viz wait <slug> [--merge] [--resume] [--timeout <secs>]",
		);
	const slug = validateSlug(rawSlug);
	const payloadPath = `${sessionDir(slug)}/payload.json`;
	if (!existsSync(payloadPath)) die(`no session for ${slug} — render it first`);

	const timeoutRaw = flagValue(rest, "--timeout");
	let timeout = 300;
	if (timeoutRaw !== undefined) {
		timeout = parseInt(timeoutRaw, 10);
		if (Number.isNaN(timeout) || timeout <= 0)
			die(
				`invalid --timeout value: "${timeoutRaw}" — must be a positive number of seconds`,
			);
	}
	clearStale(slug);

	if (settled(readWaitState(payloadPath))) return;

	process.stderr.write(`[viz] waiting for ${slug}`);
	const deadline = Date.now() + timeout * 1000;
	while (Date.now() < deadline) {
		await Bun.sleep(2000);
		if (settled(readWaitState(payloadPath))) {
			process.stderr.write(" done\n");
			return;
		}
		process.stderr.write(".");
	}
	process.stderr.write("\n");
	markStale(slug);
	const resume = shellCommand(selfCommand(["viz", "wait", slug, "--resume"]));
	die(
		`timed out after ${timeout}s — all_clear not reached for ${slug}\n  resume with: ${resume}`,
	);
}
