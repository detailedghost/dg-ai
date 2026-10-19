import { parseJsonLines } from "./json-lines";
import type { Backend, BuildArgsInput, ParsedResult } from "./types";

/**
 * Backend adapter for pi-coding-agent (`pi`). No sandbox/approval or cwd
 * flags exist for this CLI; those concerns are handled at spawn level.
 */
export const pi: Backend = {
	bin: "pi",

	buildArgs(input: BuildArgsInput): string[] {
		const args = ["--print", input.prompt, "--mode", "json"];
		if (input.resume) args.push("--resume", input.resume);
		if (input.model) args.push("--model", input.model);
		if (input.effort) args.push("--thinking", input.effort);
		return args;
	},

	parseEvents(stdout: string): ParsedResult {
		let sessionId: string | null = null;
		let message = "";

		for (const event of parseJsonLines(stdout)) {

			if (event.type === "session" && sessionId === null) {
				sessionId = event.id ?? null;
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const content = event.message.content ?? [];
				message = content
					.filter((block: any) => block.type === "text")
					.map((block: any) => block.text)
					.join("");
			}
		}

		return { sessionId, message };
	},

	install: {
		hint: "npm package @earendil-works/pi-coding-agent",
		command: "npm install -g @earendil-works/pi-coding-agent",
	},
};
