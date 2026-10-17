import { describe, expect, test } from "bun:test";
import { isAiUsageLimit } from "../src";

describe("isAiUsageLimit", () => {
	test.each([
		"You’ve hit the rate limit for your plan.",
		"You've hit your team's API rate limit.",
		"You’ve reached your free Grok Build usage limit for now.",
		"subscription:free-usage-exhausted: quota hit",
		"resource-exhausted: Too many requests for team example",
		"Some resource has been exhausted: You are sending requests too quickly.",
		"API error (status 429 Too Many Requests): slow down",
	])("recognizes Grok limits in plain and native streaming output: %s", (message) => {
		expect(isAiUsageLimit(message)).toBe(true);
		expect(isAiUsageLimit(JSON.stringify({ type: "error", message }))).toBe(true);
		expect(isAiUsageLimit(JSON.stringify({ type: "text", data: message }))).toBe(false);
		expect(isAiUsageLimit(`+ ${message}`)).toBe(false);
	});
	test.each([
		"You've hit your limit · resets 8pm (America/Chicago)",
		"ERROR: You’ve hit your usage limit. Try again later.",
		"You have reached your token limit",
		"You're out of extra usage",
		'API Error: 429 {"error":{"type":"rate_limit_error"}}',
		"\u001b[31mError: rate limit exceeded\u001b[0m",
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Too many requests" },
		}),
		JSON.stringify({
			type: "result",
			is_error: true,
			result: "You've hit your limit",
		}),
		JSON.stringify({
			type: "result",
			is_error: true,
			errors: ["Error: quota exceeded"],
		}),
	])("recognizes a CLI limit diagnostic: %s", (output) => {
		expect(isAiUsageLimit(output)).toBe(true);
	});

	test.each([
		"",
		"429",
		"Error: connection reset",
		"Please run /login",
		"+ You've hit your limit",
		" You've hit your limit",
		"  Rate limit exceeded",
		"The API returns rate_limit_error when busy",
		"throw new Error('rate limit exceeded')",
		JSON.stringify({
			type: "result",
			is_error: false,
			result: "You've hit your limit",
		}),
		JSON.stringify({
			type: "assistant",
			message: { content: "You've hit your limit" },
		}),
		JSON.stringify({ type: "error", error: { message: "Connection failed" } }),
		"{malformed json}",
	])("ignores ordinary output: %s", (output) => {
		expect(isAiUsageLimit(output)).toBe(false);
	});
});
