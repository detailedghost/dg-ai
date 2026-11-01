import { afterEach, describe, expect, test } from "bun:test";
import { PROTON_SESSION_NAME } from "@dg/inbox";
import {
	PROTECTED_SESSIONS,
	protectedSessionRefusal,
} from "../../src/pw/core/protected-session";

const ENV_KEY = "PLAYWRIGHT_CLI_SESSION";
const saved = process.env[ENV_KEY];

afterEach(() => {
	if (saved === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = saved;
});

describe("pw protectedSessionRefusal", () => {
	test("protects the inbox Proton session name", () => {
		expect(PROTECTED_SESSIONS).toContain(PROTON_SESSION_NAME);
	});

	test.each([
		[["-s=inbox-proton", "cookie-list"]],
		[["-s=inbox-proton", "cookie-get", "AUTH"]],
		[["--session", "inbox-proton", "state-save", "out.json"]],
		[["--session=inbox-proton", "network", "--request-headers"]],
		[["network", "-s=inbox-proton", "--filter", "/api/", "--request-headers"]],
	])("refuses %p", (argv) => {
		delete process.env[ENV_KEY];
		expect(protectedSessionRefusal(argv)).toContain("inbox-proton");
	});

	test("refuses when the session comes from the environment", () => {
		process.env[ENV_KEY] = "inbox-proton";
		expect(protectedSessionRefusal(["cookie-list"])).toContain("inbox-proton");
	});

	test.each([
		[["-s=inbox-proton", "network"]],
		[["-s=inbox-proton", "snapshot"]],
		[["-s=web", "cookie-list"]],
		[["-s=web", "network", "--request-headers"]],
		[["cookie-list"]],
		[["-s=inbox-proton", "eval", "--", "--request-headers"]],
	])("allows %p", (argv) => {
		delete process.env[ENV_KEY];
		expect(protectedSessionRefusal(argv)).toBeUndefined();
	});
});
