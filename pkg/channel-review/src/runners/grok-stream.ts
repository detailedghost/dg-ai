export type GrokStreamFold = {
	text: string;
	error?: string;
	stopReason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Folds stdout from the xAI Grok Build CLI.
 *
 * `streaming-json` is newline-delimited events: `{type:"text",data}`,
 * `{type:"thought",data}` (ignored), `{type:"error",message}`, and
 * `{type:"end",stopReason}`. `json` is one object `{text,stopReason}`.
 * `plain` is the raw text. Non-JSON lines are kept until the first event,
 * then ignored so a mixed job log does not fold later stderr into the answer.
 */
export function foldGrokStream(stdout: string): GrokStreamFold {
	let text = "";
	const errors: string[] = [];
	let stopReason: string | undefined;
	let sawEvent = false;

	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			if (!sawEvent) text += `${line}\n`;
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (typeof parsed.type === "string") {
			sawEvent = true;
			if (parsed.type === "text" && typeof parsed.data === "string") text += parsed.data;
			else if (parsed.type === "error" && typeof parsed.message === "string")
				errors.push(parsed.message);
			else if (parsed.type === "end" && typeof parsed.stopReason === "string")
				stopReason = parsed.stopReason;
			continue;
		}
		if (typeof parsed.text === "string" || typeof parsed.stopReason === "string")
			sawEvent = true;
		if (typeof parsed.text === "string") text += parsed.text;
		if (typeof parsed.stopReason === "string") stopReason = parsed.stopReason;
		if (typeof parsed.error === "string") errors.push(parsed.error);
		else if (parsed.stopReason === "error" && typeof parsed.message === "string")
			errors.push(parsed.message);
	}

	return {
		text,
		...(errors.length > 0 ? { error: errors.join("\n") } : {}),
		...(stopReason !== undefined ? { stopReason } : {}),
	};
}
