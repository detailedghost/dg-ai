import { isRecord } from "./assert";

// Match CLI diagnostics, rather than rate-limit words in reviewed code or diffs.
const LIMIT_LINE =
	/^(?:(?:API )?error:\s*)?(?:you(?:['’]ve| have) (?:hit|reached) your (?:usage |rate |token )?limit\b|you(?:['’]re| are) out of (?:extra )?usage\b|(?:usage|token|rate) limit (?:reached|exceeded)\b|rate_limit_error\b|(?:429\b.*(?:rate_limit_error|rate.?limit|quota)|(?:insufficient_quota|quota exceeded)\b))/i;

// Grok Build diagnostics: xai-org/grok-build, sampling/error.rs.
const GROK_LIMIT_LINE =
	/^(?:error:\s*)?(?:you['’]ve hit (?:the rate limit for your plan|your team['’]s API rate limit)\b|you['’]ve reached your free Grok Build usage limit\b|subscription:free-usage-exhausted\b|resource-exhausted:\s*Too many requests\b|Some resource has been exhausted:\s*You are sending requests too quickly\b|API error \(status 429\b|Rate limited\b)/i;

function limitMessage(value: unknown): boolean {
	return (
		typeof value === "string" &&
		(LIMIT_LINE.test(value.trimEnd()) || GROK_LIMIT_LINE.test(value.trimEnd()))
	);
}

/** Recognize usage/quota exhaustion in Claude, Codex and other AI CLI output. */
export function isAiUsageLimit(output: string): boolean {
	const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	return clean.split(/\r?\n/).some((line) => {
		if (limitMessage(line)) return true;
		if (!line.trimStart().startsWith("{")) return false;
		try {
			const event: unknown = JSON.parse(line);
			if (!isRecord(event)) return false;
			if (event.type === "error") {
				if (limitMessage(event.message)) return true;
				return (
					isRecord(event.error) && (
						event.error.type === "rate_limit_error" ||
						event.error.type === "insufficient_quota" ||
						limitMessage(event.error.message)
					)
				);
			}
			return (
				event.type === "result" &&
				event.is_error === true &&
				(limitMessage(event.result) ||
					(Array.isArray(event.errors) && event.errors.some(limitMessage)))
			);
		} catch {
			return false;
		}
	});
}
