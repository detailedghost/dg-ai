import type { Backend, BuildArgsInput, ParsedResult } from "./types";

function buildArgs(input: BuildArgsInput): string[] {
	const args = ["-p", input.prompt, "--output-format", "streaming-json", "--yolo", "--no-auto-update"];
	if (input.resume) args.push("--resume", input.resume);
	if (input.model) args.push("--model", input.model);
	if (input.effort) args.push("--effort", input.effort);
	return args;
}

function parseEvents(stdout: string): ParsedResult {
	let sessionId: string | null = null;
	let message = "";
	let errorMessage = "";

	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (sessionId === null && typeof event.sessionId === "string") {
			sessionId = event.sessionId;
		}
		if (event.type === "text" && typeof event.data === "string") {
			message += event.data;
		} else if (event.type === "error" && typeof event.message === "string") {
			errorMessage = event.message;
		}
	}

	return { sessionId, message: message || errorMessage };
}

/** Grok Build adapter with structured event parsing and model/effort passthrough. */
export const grok: Backend = {
	bin: "grok",
	buildArgs,
	parseEvents,
	install: {
		hint: "Grok Build CLI (`grok`)",
		command: "curl -fsSL https://x.ai/cli/install.sh | bash",
	},
};
