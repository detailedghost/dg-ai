// Backend adapter for the opencode CLI (1.17.8). Streams JSONL events on
// stdout; text can arrive as multiple discrete "text" events per turn.

import type { Backend, BuildArgsInput, ParsedResult } from "./types";

export const opencode: Backend = {
	bin: "opencode",
	buildArgs(input: BuildArgsInput): string[] {
		const args = ["run", input.prompt, "--format", "json", "--dangerously-skip-permissions"];
		if (input.resume) args.push("--session", input.resume);
		if (input.model) args.push("--model", input.model);
		if (input.effort) args.push("--variant", input.effort);
		return args;
	},
	parseEvents(stdout: string): ParsedResult {
		let sessionId: string | null = null;
		let message = "";
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (sessionId === null && event.sessionID) sessionId = event.sessionID;
			if (event.type === "text" && typeof event.part?.text === "string") {
				message += event.part.text;
			}
		}
		return { sessionId, message };
	},
	install: {
		hint: "npm package opencode-ai",
		command: "npm install -g opencode-ai",
	},
};
