/**
 * Backend adapter for OpenAI's codex-cli (`codex exec`). Builds the argv for
 * fresh and resumed turns and decodes the JSONL event stream codex-cli
 * emits on stdout into a { sessionId, message } result, including pulling
 * an error message out of the stream when a turn fails.
 */

import type { Backend, BuildArgsInput, ParsedResult } from "./types";

function buildArgs(input: BuildArgsInput): string[] {
	// `-a/--ask-for-approval` doesn't exist on `codex exec` — only `-s/--sandbox` does.
	const args = input.resume
		? ["exec", "resume", input.resume, input.prompt, "--json"]
		: ["exec", input.prompt, "--json", "-s", "workspace-write"];

	if (input.model) args.push("-m", input.model);
	if (input.effort) args.push("-c", `model_reasoning_effort=${input.effort}`);

	return args;
}

function unwrapErrorMessage(raw: string): string {
	try {
		const parsed = JSON.parse(raw);
		return parsed?.error?.message ?? raw;
	} catch {
		return raw;
	}
}

function parseEvents(stdout: string): ParsedResult {
	let sessionId: string | null = null;
	let message = "";
	let fallback = "";

	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;

		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.type === "thread.started" && sessionId === null) {
			sessionId = event.thread_id ?? null;
		} else if (event.type === "item.completed" && event.item?.type === "agent_message") {
			message = event.item.text ?? "";
		} else if (event.type === "turn.failed") {
			fallback = unwrapErrorMessage(event.error?.message ?? "");
		} else if (event.type === "error") {
			fallback = unwrapErrorMessage(event.message ?? "");
		}
	}

	return { sessionId, message: message || fallback };
}

export const codex: Backend = {
	bin: "codex",
	buildArgs,
	parseEvents,
	install: {
		hint: "npm package @openai/codex",
		command: "npm install -g @openai/codex",
	},
};
