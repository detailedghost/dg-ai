/**
 * Backend adapter for Snowflake's Cortex Code CLI (`cortex`). It's a
 * Claude-Code-style agentic coder, so `--print --output-format stream-json`
 * emits the familiar system/init → assistant → result event stream, which
 * parseEvents decodes into { sessionId, message }.
 *
 * Fresh turns pass `--dangerously-allow-all-tool-calls` so a headless run
 * never blocks on a permission prompt — the codex `-s workspace-write` /
 * opencode `--dangerously-skip-permissions` equivalent. That also leaves
 * cortex's built-in Snowflake SQL tool fully enabled (DDL/DML included).
 */

import { parseJsonLines } from "./json-lines";
import type { Backend, BuildArgsInput, ParsedResult } from "./types";

function buildArgs(input: BuildArgsInput): string[] {
	const args = [
		"--print",
		input.prompt,
		"--output-format",
		"stream-json",
		"--no-auto-update",
	];

	// A resume already carries the session's approved posture; only a fresh
	// turn needs the auto-approve guard applied up front.
	if (input.resume) {
		args.push("--resume", input.resume);
	} else {
		args.push("--dangerously-allow-all-tool-calls");
	}

	if (input.model) args.push("--model", input.model);
	if (input.effort) args.push("--effort", input.effort);

	return args;
}

function parseEvents(stdout: string): ParsedResult {
	let sessionId: string | null = null;
	let resultMessage = "";
	let assistantText = "";

	for (const event of parseJsonLines(stdout)) {

		if (sessionId === null && event.session_id) {
			sessionId = event.session_id;
		}

		if (event.type === "assistant") {
			// Last assistant message wins — the final one holds the answer text.
			const content = event.message?.content ?? [];
			assistantText = content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text)
				.join("");
		} else if (event.type === "result" && typeof event.result === "string") {
			resultMessage = event.result;
		}
	}

	return { sessionId, message: resultMessage || assistantText };
}

/** Cortex Code adapter with headless result parsing and session continuation. */
export const cortex: Backend = {
	bin: "cortex",
	buildArgs,
	parseEvents,
	install: {
		hint: "Snowflake Cortex Code CLI (`cortex`)",
		command:
			"curl --proto '=https' --tlsv1.2 -fsSL https://sfc-repo.snowflakecomputing.com/cortex-code/install.sh | bash",
		url: "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli",
	},
};
