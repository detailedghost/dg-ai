import type { HookEvent, HookInput } from "./types";

export async function readStdinJson(
	stdin: AsyncIterable<string | Uint8Array>,
): Promise<HookInput> {
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	for await (const chunk of stdin)
		chunks.push(
			typeof chunk === "string"
				? chunk
				: decoder.decode(chunk, { stream: true }),
		);
	chunks.push(decoder.decode());
	try {
		const parsed: unknown = JSON.parse(chunks.join(""));
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as HookInput)
			: {};
	} catch {
		return {};
	}
}

export function additionalContextJson(
	event: HookEvent,
	additionalContext: string,
): string {
	return JSON.stringify({
		hookSpecificOutput: { hookEventName: event, additionalContext },
	});
}

export function askJson(reason: string): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
			permissionDecisionReason: reason,
		},
	});
}

export function bashCommand(input: HookInput): string {
	const toolInput = input.tool_input ?? {};
	const command = toolInput["command"] ?? toolInput["cmd"];
	return typeof command === "string" ? command : "";
}
