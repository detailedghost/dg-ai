import { workspaceDirForProfile } from "../../workspace/profile";
import { fixturePath, fixtureConfigPath } from "../../../test/fixture-paths";
import { describe, expect, test } from "bun:test";
import { main } from "../../cli/index";

const configArgs = ["--config", fixtureConfigPath];

async function runCli(args: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (...values: unknown[]) =>
		stdout.push(values.map(String).join(" "));
	console.error = (...values: unknown[]) =>
		stderr.push(values.map(String).join(" "));
	try {
		await main([
			...args,
			...configArgs,
			"--dir",
			args.includes("--dir")
				? args[args.indexOf("--dir") + 1]
				: workspaceDirForProfile({
						provider: "outlook",
						accountProfile: args.includes("--account-profile")
							? args[args.indexOf("--account-profile") + 1]
							: undefined,
						base: "/tmp/dg-inbox-default-workspaces",
					}),
		]);
		return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code: 0 };
	} catch (error) {
		stderr.push(error instanceof Error ? error.message : String(error));
		return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code: 1 };
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}

describe("Outlook CLI provider", () => {
	test("runs redacted Outlook inventory from synthetic fixture data", async () => {
		const dir = `/tmp/email-organizer-outlook-inventory-${crypto.randomUUID()}`;
		const folders = await runCli([
			"load",
			"folders",
			"--provider",
			"outlook",
			"--dir",
			dir,
		]);
		expect(folders.code, folders.stderr).toBe(0);
		const proc = await runCli([
			"batch",
			"--provider",
			"outlook",
			"--dir",
			dir,
			"--folder",
			"inbox",
			"--limit",
			"1",
			"--ai",
		]);
		expect(proc.code, proc.stderr).toBe(0);
		const status = await Bun.file(`${dir}/messages/_status.json`).text();
		const messagePath = JSON.parse(status).items[0].file;
		const message = await Bun.file(`${dir}/${messagePath}`).text();
		expect(message).not.toContain("billing@contoso.com");
		expect(message).not.toContain("123456789");
		expect(message).not.toContain("987654321");
		expect(message).toContain('"fromDomain": "contoso.com"');
		expect(message).toContain('"sourceIdHash"');
	});

	test("supports workflow aliases for Outlook load and batch", async () => {
		const folders = await runCli([
			"load",
			"folders",
			"--provider",
			"outlook",
			"--ai-summary",
		]);
		expect(folders.code, folders.stderr).toBe(0);
		expect(JSON.parse(folders.stdout)).toMatchObject({
			kind: "workspace-load-folders",
			provider: "outlook",
			count: 3,
		});

		const dir = `/tmp/email-organizer-outlook-batch-${crypto.randomUUID()}`;
		await runCli(["load", "folders", "--provider", "outlook", "--dir", dir]);
		const batch = await runCli([
			"batch",
			"--provider",
			"outlook",
			"--dir",
			dir,
			"--folder",
			"inbox",
			"--limit",
			"1",
			"--ai-summary",
		]);
		expect(batch.code, batch.stderr).toBe(0);
		expect(await Bun.file(`${dir}/messages/_status.json`).text()).not.toContain(
			"billing@contoso.com",
		);
	});

	test("initializes Outlook workspace login metadata without tokens", async () => {
		const dir = `/tmp/email-organizer-outlook-init-${crypto.randomUUID()}`;
		const proc = await runCli([
			"init",
			"--provider",
			"outlook",
			"--dir",
			dir,
			"--username",
			"user@contoso.com",
		]);
		expect(proc.code, proc.stderr).toBe(0);
		const login = await Bun.file(`${dir}/login.json`).text();
		expect(login).toContain('"provider": "outlook"');
		expect(login).not.toContain("accessToken");
		expect(login).not.toContain("refreshToken");
		expect(login).not.toContain("secret");
	});

	test("initializes separate Outlook account profile workspaces", async () => {
		const firstProfile = `user-a-${crypto.randomUUID()}`;
		const secondProfile = `user-b-${crypto.randomUUID()}`;
		const first = await runCli([
			"init",
			"--provider",
			"outlook",
			"--account-profile",
			firstProfile,
			"--username",
			"a@contoso.com",
		]);
		const second = await runCli([
			"init",
			"--provider",
			"outlook",
			"--account-profile",
			secondProfile,
			"--username",
			"b@contoso.com",
		]);

		expect(first.code, first.stderr).toBe(0);
		expect(second.code, second.stderr).toBe(0);

		const firstLogin = await Bun.file(
			`${workspaceDirForProfile({ provider: "outlook", accountProfile: firstProfile, base: "/tmp/dg-inbox-default-workspaces" })}/login.json`,
		).json();
		const secondLogin = await Bun.file(
			`${workspaceDirForProfile({ provider: "outlook", accountProfile: secondProfile, base: "/tmp/dg-inbox-default-workspaces" })}/login.json`,
		).json();
		expect(firstLogin).toMatchObject({
			provider: "outlook",
			accountProfile: firstProfile,
			username: "a@contoso.com",
		});
		expect(secondLogin).toMatchObject({
			provider: "outlook",
			accountProfile: secondProfile,
			username: "b@contoso.com",
		});
		expect(firstLogin.workspaceDir).not.toBe(secondLogin.workspaceDir);
		expect(JSON.stringify(firstLogin)).not.toContain("accessToken");
		expect(JSON.stringify(secondLogin)).not.toContain("refreshToken");
	});

	test("resolves the provider from an existing profile's login.json without --provider", async () => {
		const profile = `profile-detect-${crypto.randomUUID()}`;
		const init = await runCli([
			"init",
			"--provider",
			"outlook",
			"--account-profile",
			profile,
			"--username",
			"detect@contoso.com",
		]);
		expect(init.code, init.stderr).toBe(0);

		const folders = await runCli([
			"load",
			"folders",
			"--account-profile",
			profile,
		]);
		expect(folders.code, folders.stderr).toBe(0);
		expect(JSON.parse(folders.stdout)).toMatchObject({
			kind: "workspace-load-folders",
			provider: "outlook",
			count: 3,
		});

		const batch = await runCli([
			"batch",
			"--account-profile",
			profile,
			"--folder",
			"inbox",
			"--limit",
			"1",
		]);
		expect(batch.code, batch.stderr).toBe(0);
		expect(JSON.parse(batch.stdout)).toMatchObject({
			kind: "workspace-batch",
			provider: "outlook",
		});
	});

	test("refuses confirmed apply without a matching dry-run report", async () => {
		const dir = `/tmp/email-organizer-outlook-plan-${crypto.randomUUID()}`;
		expect(
			(await runCli(["load", "folders", "--provider", "outlook", "--dir", dir]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--provider",
					"outlook",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"1",
				])
			).code,
		).toBe(0);

		const confirm = await runCli([
			"apply",
			"--provider",
			"outlook",
			"--dir",
			dir,
			"--confirm",
		]);
		expect(confirm.code).toBe(1);
		expect(confirm.stderr).toContain(
			"requires a successful apply --dry-run report",
		);
	});
});
