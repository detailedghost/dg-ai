import { expect, test } from "bun:test";
import type { runCapture } from "@dg/common/node";
import { grokAuthFailure, probeGrok } from "../src/runners/grok";

const THRASH = { name: "thrash", userInvocable: true };
type Captured = Awaited<ReturnType<typeof runCapture>>;
const result = (stdout: string, status = 0): Captured => ({
	stdout,
	status,
	signal: null,
	stderr: "",
});

function harness({
	banner = "You are logged in with example.com.",
	skills = [THRASH] as unknown[],
	models = result(banner),
	inspect = result(JSON.stringify({ skills })),
} = {}) {
	const calls: { command: string; args: string[]; options: unknown }[] = [];
	const capture: typeof runCapture = async (command, args, options) => {
		calls.push({ command, args, options });
		return args[0] === "models" ? models : inspect;
	};
	return { calls, probe: () => probeGrok("/bin/grok", "/work", capture) };
}

test.each([
	"You are logged in with example.com.",
	"You are using XAI_API_KEY.",
	"Model 'custom' is using its own API key.",
	"You are authenticated via deployment key.",
])("uses Grok's auth resolution and discovered skills: %s", async (banner) => {
	const h = harness({ banner });
	expect(await h.probe()).toEqual({ ok: true });
	expect(h.calls).toEqual([
		{
			command: "/bin/grok",
			args: ["models"],
			options: { cwd: "/work", timeoutMs: 60_000 },
		},
		{
			command: "/bin/grok",
			args: ["inspect", "--json"],
			options: { cwd: "/work", timeoutMs: 60_000 },
		},
	]);
});

test("signed-out models can exit zero; do not mistake that for readiness", async () => {
	const h = harness({ banner: "You are not authenticated." });
	expect(await h.probe()).toEqual({ ok: false, code: "CR-202" });
	expect(h.calls).toHaveLength(1);
});

test.each([
	[],
	[{ ...THRASH, disabled: true }],
	[{ ...THRASH, compatibilityStatus: "disabled" }],
	[{ ...THRASH, userInvocable: false }],
	[{ ...THRASH, collidesWith: "thrash", invocableAs: "plugin:thrash" }],
	[{ name: "other", userInvocable: true }],
].map(skills => [skills] as const))("requires an enabled, unambiguous /thrash command: %j", async (skills) => {
	expect(await harness({ skills }).probe()).toEqual({
		ok: false,
		code: "CR-206",
	});
});

test("accepts the dg plugin thrash when another thrash shares its name", async () => {
	const skills = [
		{ ...THRASH, collidesWith: "thrash", invocableAs: "user:thrash" },
		{ ...THRASH, collidesWith: "thrash", invocableAs: "dg:thrash" },
	];
	expect(await harness({ skills }).probe()).toEqual({ ok: true });
});

test.each([
	{ models: result("", 1) },
	{ banner: "unrecognized auth status" },
	{ inspect: result("unsupported option", 1) },
	{ inspect: result("not json") },
	{ inspect: result("{}") },
])(
	"reports utility or schema failures separately from missing auth/skill: %j",
	async (options) => {
		expect(await harness(options).probe()).toEqual({
			ok: false,
			code: "CR-203",
		});
	},
);

test.each([
	["ENOENT", "CR-201"],
	["ETIMEDOUT", "CR-203"],
] as const)("classifies a failed probe process: %s", async (code, expected) => {
	const capture: typeof runCapture = async () => {
		throw Object.assign(new Error("probe failed"), { code });
	};
	expect(await probeGrok("/bin/grok", "/work", capture)).toEqual({
		ok: false,
		code: expected,
	});
});

test.each([
	"Error: Not signed in. Run `grok login` to authenticate.",
	JSON.stringify({
		type: "error",
		message:
			"Your auth token is invalid or expired. Run `grok login` to re-authenticate.",
	}),
])("recognizes Grok auth errors on either stream: %s", (output) => {
	expect(grokAuthFailure(output)).toBe(true);
});

test.each([
	"+ Not signed in",
	" Not signed in",
	JSON.stringify({ type: "text", data: "Not signed in" }),
	JSON.stringify({
		type: "tool_call_update",
		rawOutput: { message: "Not signed in" },
	}),
	JSON.stringify({ type: "error", message: "Connection refused" }),
])(
	"ignores auth words in reviewed content and unrelated errors: %s",
	(output) => {
		expect(grokAuthFailure(output)).toBe(false);
	},
);
