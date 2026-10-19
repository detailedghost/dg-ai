import { parseJsonLines } from "./json-lines";
import type { Backend, BuildArgsInput, ParsedResult } from "./types";

/** Backend adapter for GitHub Copilot CLI (`copilot`), driven non-interactively via `-p` + JSON output. */
export const copilot: Backend = {
	bin: "copilot",

	buildArgs(input: BuildArgsInput): string[] {
		const args = ["-p", input.prompt, "--allow-all-tools", "--output-format", "json"];
		if (input.resume) args.push("--resume", input.resume);
		if (input.model) args.push("--model", input.model);
		if (input.effort) args.push("--effort", input.effort);
		return args;
	},

	parseEvents(stdout: string): ParsedResult {
		let sessionId: string | null = null;
		let message = "";

		for (const event of parseJsonLines(stdout)) {

			if (event.type === "assistant.message") {
				message = event.data?.content ?? message;
			} else if (event.type === "result") {
				sessionId = event.sessionId ?? null;
			}
		}

		return { sessionId, message };
	},

	install: {
		hint: "npm package @github/copilot",
		command: "npm install -g @github/copilot",
	},
};
