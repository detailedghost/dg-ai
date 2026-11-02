import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { PROTON_SESSION_NAME } from "@dg/inbox";
import {
	PROTECTED_SESSIONS,
	protectedSessionRefusal,
} from "../../src/pw/core/protected-session";

const ENV_KEY = "PLAYWRIGHT_CLI_SESSION";
const saved = process.env[ENV_KEY];
const savedHome = process.env["DG_HOME"];

afterEach(() => {
	if (saved === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = saved;
	if (savedHome === undefined) delete process.env["DG_HOME"];
	else process.env["DG_HOME"] = savedHome;
});

describe("pw protectedSessionRefusal for the Proton profile", () => {
	const home = "/tmp/dg-protected-home";

	test.each([
		[["-s=mail-copy", "open", "--profile", `${home}/inbox/proton-profile`]],
		[["-s=mail-copy", "open", `--profile=${home}/inbox/proton-profile/`]],
		[["-s=mail-copy", "open", "--profile", `${home}/inbox/../inbox/proton-profile`]],
		[
			[
				"-s=mail-copy",
				"open",
				"--windows",
				"--profile",
				"C:\\Users\\me\\AppData\\Local\\playwright-cli\\profiles\\inbox-proton",
			],
		],
		[
			[
				"-s=mail-copy",
				"open",
				"--windows",
				"--profile",
				"C:\\Users\\me\\AppData\\Local\\playwright-cli\\profiles\\inbox-proton\\.",
			],
		],
		[
			[
				"-s=mail-copy",
				"open",
				"--windows",
				"--profile=C:\\Users\\me\\AppData\\Local\\playwright-cli\\profiles\\web\\..\\inbox-proton\\",
			],
		],
	])("refuses opening the protected profile under another name: %p", (argv) => {
		delete process.env[ENV_KEY];
		process.env["DG_HOME"] = home;
		expect(protectedSessionRefusal(argv)).toContain("inbox-proton");
	});

	test("refuses the protected session name in another case", () => {
		delete process.env[ENV_KEY];
		expect(
			protectedSessionRefusal([
				"-s=INBOX-PROTON",
				"open",
				"--windows",
				"https://mail.proton.me",
			]),
		).toContain("signed-in mailbox");
	});

	test("refuses a symlink that points at the protected profile", () => {
		delete process.env[ENV_KEY];
		const root = mkdtempSync(join(tmpdir(), "dg-protected-link-"));
		try {
			process.env["DG_HOME"] = join(root, "dg");
			const target = join(resolveDgPaths().stateDir, "inbox", "proton-profile");
			mkdirSync(target, { recursive: true });
			symlinkSync(target, join(root, "mail-copy"));
			expect(
				protectedSessionRefusal([
					"-s=mail-copy",
					"open",
					"--profile",
					join(root, "mail-copy"),
				]),
			).toContain("inbox-proton");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("allows another profile", () => {
		delete process.env[ENV_KEY];
		process.env["DG_HOME"] = home;
		expect(
			protectedSessionRefusal(["-s=web", "open", "--profile", `${home}/web`]),
		).toBeUndefined();
	});
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
		[["-s=inbox-proton", "network"]],
		[["-s=inbox-proton", "eval", "document.cookie"]],
		[["-s=inbox-proton", "snapshot"]],
		[["-s=inbox-proton", "localstorage-list"]],
		[["-s=inbox-proton", "sessionstorage-get", "key"]],
		[["-s=inbox-proton", "tracing-start"]],
		[["-s=inbox-proton", "route", "**/*"]],
		[["-s=inbox-proton", "screenshot"]],
		[["-s=inbox-proton", "goto", "https://example.test"]],
		[["-s=inbox-proton", "eval", "--", "--request-headers"]],
	])("refuses %p", (argv) => {
		delete process.env[ENV_KEY];
		expect(protectedSessionRefusal(argv)).toContain("inbox-proton");
	});

	test("refuses when the session comes from the environment", () => {
		process.env[ENV_KEY] = "inbox-proton";
		expect(protectedSessionRefusal(["cookie-list"])).toContain("inbox-proton");
	});

	test.each([
		[["-s=inbox-proton", "close"]],
		[["-s=inbox-proton", "delete-data"]],
		[["-s=inbox-proton", "tab-list"]],
		[["list"]],
		[["-s=web", "cookie-list"]],
		[["-s=web", "network", "--request-headers"]],
		[["-s=web", "eval", "1"]],
		[["cookie-list"]],
	])("allows %p", (argv) => {
		delete process.env[ENV_KEY];
		expect(protectedSessionRefusal(argv)).toBeUndefined();
	});

	test("pw-code refuses any code on the protected session", () => {
		delete process.env[ENV_KEY];
		expect(
			protectedSessionRefusal(["-s=inbox-proton", "return 1"], "pw-code"),
		).toContain("inbox-proton");
		process.env[ENV_KEY] = "inbox-proton";
		expect(protectedSessionRefusal(["--filename=x.js"], "pw-code")).toContain(
			"inbox-proton",
		);
	});

	test("pw-code allows other sessions", () => {
		delete process.env[ENV_KEY];
		expect(
			protectedSessionRefusal(["-s=web", "return 1"], "pw-code"),
		).toBeUndefined();
		expect(protectedSessionRefusal(["return 1"], "pw-code")).toBeUndefined();
	});
});
