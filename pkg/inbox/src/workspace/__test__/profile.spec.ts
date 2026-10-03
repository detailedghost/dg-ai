import { describe, expect, test } from "bun:test";
import { detectProfileProvider, workspaceDirForProfile } from "../profile";

function tmpBase(name: string): string {
	return `/tmp/email-organizer-tests-${crypto.randomUUID()}/${name}`;
}

describe("workspaceDirForProfile", () => {
	test("prefers an explicit --dir over provider/profile inference", () => {
		expect(
			workspaceDirForProfile({
				provider: "outlook",
				explicitDir: "custom/path",
				accountProfile: "work",
			}),
		).toBe("custom/path");
	});

	test("builds a base/provider/profile path when a profile is given", () => {
		expect(
			workspaceDirForProfile({
				provider: "outlook",
				accountProfile: "Work Account",
				base: "dist",
			}),
		).toBe("dist/outlook/work-account");
	});

	test("falls back to base/provider when no profile is given", () => {
		expect(workspaceDirForProfile({ provider: "gmail", base: "dist" })).toBe(
			"dist/gmail",
		);
	});
});

describe("detectProfileProvider", () => {
	test("finds the provider whose dist/<provider>/<profile>/login.json already exists", async () => {
		const base = tmpBase("detect-outlook");
		await Bun.write(
			`${base}/outlook/work/login.json`,
			JSON.stringify({ provider: "outlook" }),
		);

		expect(await detectProfileProvider({ accountProfile: "work", base })).toBe(
			"outlook",
		);
	});

	test("returns undefined when no provider has that profile yet", async () => {
		const base = tmpBase("detect-missing");
		expect(
			await detectProfileProvider({
				accountProfile: "brand-new-profile",
				base,
			}),
		).toBeUndefined();
	});

	test("returns undefined without an account profile", async () => {
		const base = tmpBase("detect-empty");
		expect(await detectProfileProvider({ base })).toBeUndefined();
	});
});
