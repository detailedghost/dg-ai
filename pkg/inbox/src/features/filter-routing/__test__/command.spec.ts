import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { main } from "../../../cli/index";
import { writeJsonFile } from "../../../utils/json";

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
		await main(args);
		return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code: 0 };
	} catch (error) {
		stderr.push(error instanceof Error ? error.message : String(error));
		return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code: 1 };
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}

function tmpPath(name: string): string {
	return `/tmp/email-organizer-route-tests-${crypto.randomUUID()}/${name}`;
}

describe("filter routing feature", () => {
	test("loads route profiles from config home and creates the target folder and filter", async () => {
		const dir = tmpPath("workspace");
		const configHome = tmpPath("email-cleanup");
		const configPath = tmpPath("organizer.config.json");
		const dataPath = tmpPath("proton-dataset.json");
		await Bun.$`mkdir -p ${dirname(configPath)} ${configHome}`.quiet();
		await writeJsonFile(dataPath, {
			folders: [
				{ id: "0", name: "Inbox", type: "system", total: 0, unread: 0 },
			],
			filters: [],
			messages: [],
		});
		await writeJsonFile(configPath, {
			configHome,
			protonmail: {
				dataPath,
				liveBrowser: false,
			},
		});
		await writeJsonFile(`${configHome}/route-profiles.json`, {
			routeProfiles: {
				updates: {
					folderName: "Updates",
					filterName: "Updates - Projects",
					domainFilters: ["backerpress.com", "kickstarter-project.com"],
					subjectDomainFilters: [
						{
							domain: "kickstarter.com",
							subjectContains: ["project update", "new message about"],
						},
					],
				},
			},
		});

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--config", configPath]))
				.code,
		).toBe(0);
		expect(
			(await runCli(["load", "filters", "--dir", dir, "--config", configPath]))
				.code,
		).toBe(0);

		const dryRun = await runCli([
			"filters",
			"route",
			"--dir",
			dir,
			"--profile",
			"updates",
			"--dry-run",
			"--config",
			configPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		expect(JSON.parse(dryRun.stdout)).toMatchObject({
			kind: "workspace-filter-route-summary",
			dryRun: true,
			mutated: false,
			profile: "updates",
			folder: { name: "Updates", action: "create" },
			filter: { name: "Updates - Projects", action: "create" },
			domainFilters: 2,
			subjectDomainFilters: 1,
		});
		expect(existsSync(`${dir}/plans/filter-route-plan.json`)).toBe(true);

		const confirmed = await runCli([
			"filters",
			"route",
			"--dir",
			dir,
			"--profile",
			"updates",
			"--confirm",
			"--config",
			configPath,
		]);
		expect(confirmed.code, confirmed.stderr).toBe(0);
		const confirmedOutput = JSON.parse(confirmed.stdout);
		expect(confirmedOutput).toMatchObject({
			dryRun: false,
			mutated: true,
			folder: { name: "Updates", action: "create" },
			filter: { name: "Updates - Projects", action: "create" },
		});
		expect(existsSync(confirmedOutput.auditPath)).toBe(true);

		const dataset = await Bun.file(dataPath).json();
		expect(dataset.folders).toContainEqual(
			expect.objectContaining({ name: "Updates", path: "Updates" }),
		);
		const filter = dataset.filters.find(
			(row: { name: string }) => row.name === "Updates - Projects",
		);
		expect(filter.conditions[0]).toContain("backerpress.com");
		expect(filter.conditions[0]).toContain("kickstarter-project.com");
		expect(filter.conditions[0]).toContain("kickstarter.com");
		expect(filter.conditions[0]).toContain("project update");
	});
});
