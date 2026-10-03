import { faker } from "@faker-js/faker";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../../../cli/index";
import { validateCleanupReviewPayload } from "../command";
import { readJsonFile, writeJsonFile } from "../../../utils/json";

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

async function runCliInBackground(args: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	let resolveFirstLine: (line: string) => void = () => undefined;
	const firstLine = new Promise<string>((resolve) => {
		resolveFirstLine = resolve;
	});
	console.log = (...values: unknown[]) => {
		const line = values.map(String).join(" ");
		stdout.push(line);
		if (stdout.length === 1) {
			resolveFirstLine(line);
		}
	};
	console.error = (...values: unknown[]) =>
		stderr.push(values.map(String).join(" "));
	const run = main(args)
		.then(() => 0)
		.catch((error) => {
			stderr.push(error instanceof Error ? error.message : String(error));
			return 1;
		});
	const first = await Promise.race([
		firstLine,
		run.then(() => ""),
		Bun.sleep(2000).then(() => ""),
	]);
	if (!first) {
		console.log = originalLog;
		console.error = originalError;
		throw new Error(
			`CLI process exited before printing review URL: ${stderr.join("\n")}`,
		);
	}
	const summary = JSON.parse(first);
	return {
		summary,
		async finish() {
			const code = await run;
			console.log = originalLog;
			console.error = originalError;
			return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code };
		},
	};
}

async function postJsonWithRetry(
	url: string,
	body: unknown,
): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return response;
		} catch (error) {
			lastError = error;
			await Bun.sleep(50);
		}
	}
	throw lastError;
}

function tmpPath(name: string): string {
	return `/tmp/email-organizer-cleanup-tests-${crypto.randomUUID()}/${name}`;
}

function title(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9 ]+/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.map(
			(word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`,
		)
		.join(" ");
}

function syntheticAddress(): string {
	return faker.internet
		.email({
			provider: `${faker.word.noun()}-${faker.string.alphanumeric(8)}.example.test`,
		})
		.toLowerCase();
}

async function writeFixture() {
	const dir = tmpPath("workspace");
	const configPath = tmpPath("organizer.config.json");
	const dataPath = tmpPath("dataset.json");
	const planPath = tmpPath("cleanup-policy.json");
	const patchPath = tmpPath("cleanup-patch.json");
	await Bun.$`mkdir -p ${dirname(configPath)}`.quiet();

	const suffix = faker.string.alphanumeric(8);
	const destinationA = `Folder ${title(faker.commerce.department())} ${suffix} A`;
	const destinationB = `Folder ${title(faker.commerce.productName())} ${suffix} B`;
	const parentFolder = `Parent ${title(faker.company.buzzNoun())} ${suffix}`;
	const childFolder = `Child ${title(faker.company.buzzPhrase())} ${suffix} A`;
	const childFolderB = `Child ${title(faker.company.catchPhraseNoun())} ${suffix} B`;
	const keepLabel = `Keep ${title(faker.word.noun())} ${suffix}`;
	const createLabel = `Create ${title(faker.word.adjective())} ${suffix}`;
	const reviewLabel = `Review ${title(faker.word.verb())} ${suffix}`;
	const retiredLabel = `Retired ${title(faker.word.words(2))} ${suffix}`;
	const unusedLabel = `Unused ${title(faker.word.words(2))} ${suffix}`;
	const projectReason = faker.word.words(2).replace(/\s+/g, "-").toLowerCase();
	const companyReason = faker.word.words(2).replace(/\s+/g, "-").toLowerCase();
	const reviewReason = faker.word.words(2).replace(/\s+/g, "-").toLowerCase();
	const unmatchedReason = faker.word
		.words(2)
		.replace(/\s+/g, "-")
		.toLowerCase();
	const projectKeyword = faker.word.noun().toLowerCase();
	const companyKeyword = faker.word.noun().toLowerCase();
	const reviewKeyword = faker.word.noun().toLowerCase();
	const refusedDomain = `${faker.word.noun()}-${faker.string.alphanumeric(8)}.example.test`;

	const fixture = {
		dir,
		configPath,
		dataPath,
		planPath,
		patchPath,
		destinationA,
		destinationB,
		parentFolder,
		childFolder,
		childFolderB,
		createLabel,
		retiredLabel,
		unusedLabel,
		projectReason,
		companyReason,
		reviewReason,
		unmatchedReason,
	};

	await writeJsonFile(dataPath, {
		folders: [
			{
				id: "inbox",
				name: "Inbox",
				path: "Inbox",
				type: "system",
				total: 5,
				unread: 2,
			},
			{
				id: "legacy-root",
				name: "_",
				path: "_",
				type: "folder",
				total: 0,
				unread: 0,
			},
			{
				id: "legacy-a",
				name: destinationA,
				path: `_${"/"}${destinationA}`,
				parentId: "legacy-root",
				type: "folder",
				total: 1,
				unread: 0,
			},
			{
				id: "legacy-b",
				name: destinationB,
				path: `_${"/"}${destinationB}`,
				parentId: "legacy-root",
				type: "folder",
				total: 1,
				unread: 0,
			},
		],
		labels: [
			{ id: "label-retired", name: retiredLabel, usage: 1 },
			{ id: "label-unused", name: unusedLabel, usage: 0 },
			{ id: "label-keep", name: keepLabel, usage: 1 },
		],
		categories: [
			{ id: "label-retired", name: retiredLabel, usage: 1 },
			{ id: "label-unused", name: unusedLabel, usage: 0 },
			{ id: "label-keep", name: keepLabel, usage: 1 },
		],
		filters: [],
		messages: [
			{
				id: "msg-project",
				from: syntheticAddress(),
				subject: `${projectKeyword} ${faker.lorem.words(3)}`,
				snippet: faker.lorem.sentence(),
				folderId: "inbox",
				folderName: "Inbox",
				read: false,
			},
			{
				id: "msg-company",
				from: syntheticAddress(),
				subject: `${companyKeyword} ${faker.lorem.words(3)}`,
				snippet: faker.lorem.sentence(),
				folderId: "inbox",
				folderName: "Inbox",
				read: true,
			},
			{
				id: "msg-review",
				from: syntheticAddress(),
				subject: `${reviewKeyword} ${faker.lorem.words(3)}`,
				snippet: faker.lorem.sentence(),
				folderId: "inbox",
				folderName: "Inbox",
				read: false,
				labels: [keepLabel],
				categories: [keepLabel],
			},
			{
				id: "msg-unmatched",
				from: syntheticAddress(),
				subject: faker.lorem.words(4),
				snippet: faker.lorem.sentence(),
				folderId: "inbox",
				folderName: "Inbox",
				read: false,
			},
			{
				id: "msg-retired-label",
				from: syntheticAddress(),
				subject: faker.lorem.words(4),
				snippet: faker.lorem.sentence(),
				folderId: "legacy-a",
				folderName: destinationA,
				read: true,
				labels: [retiredLabel],
				categories: [retiredLabel],
			},
		],
	});

	await writeJsonFile(planPath, {
		kind: "mailbox-cleanup-policy",
		folders: {
			topLevel: [destinationA, destinationB, parentFolder],
			children: [
				{ parentSegments: [parentFolder], names: [childFolder, childFolderB] },
			],
			legacyMoves: [
				{ fromPath: `_${"/"}${destinationA}`, toSegments: [destinationA] },
				{ fromPath: `_${"/"}${destinationB}`, toSegments: [destinationB] },
			],
			systemFolderNames: ["Inbox"],
		},
		labels: {
			keep: [keepLabel],
			create: [createLabel, reviewLabel],
			delete: [{ name: retiredLabel, allowUsed: true }, { name: unusedLabel }],
			usedDeleteRefusalReason: faker.lorem.words(4),
		},
		filters: {
			refusedDomains: [refusedDomain],
			refusedDomainReason: faker.lorem.sentence(),
			rules: [
				{
					name: faker.lorem.words(3),
					targetSegments: [parentFolder, childFolder],
					labelNames: [],
					subjectContains: [projectKeyword],
					fromContains: [],
					priority: 10,
					reason: projectReason,
				},
				{
					name: faker.lorem.words(3),
					targetSegments: [destinationB],
					labelNames: [createLabel],
					subjectContains: [companyKeyword],
					fromContains: [],
					priority: 20,
					reason: companyReason,
				},
			],
		},
		routing: {
			lowRiskReasons: [projectReason, companyReason],
			unmatchedReason,
			reviewOnlyRules: [
				{
					keywords: [reviewKeyword],
					targetSegments: [destinationA],
					labelNames: [keepLabel, reviewLabel],
					reason: reviewReason,
				},
			],
		},
		verification: {
			legacyRoots: ["_"],
			deletedLabelsAbsent: [retiredLabel, unusedLabel],
			systemFolderNames: ["Inbox"],
		},
		artifacts: {
			mutationTarget: "local-artifact",
			compactRoutePlans: true,
		},
	});
	await writeJsonFile(configPath, { protonmail: { liveBrowser: false } });
	return fixture;
}

describe("mailbox cleanup commands", () => {
	test("plans and applies a folder tree from loaded JSON segments", async () => {
		const fixture = await writeFixture();
		const dryRun = await runCli([
			"folders",
			"plan-tree",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--dry-run",
			"--config",
			fixture.configPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		const summary = JSON.parse(dryRun.stdout);
		expect(summary).toMatchObject({
			kind: "mailbox-folder-tree-summary",
			provider: "outlook",
			dryRun: true,
			move: 2,
			mutationTarget: "local-artifact",
		});
		expect(summary.folders).toContainEqual(
			expect.objectContaining({
				action: "create",
				pathSegments: [fixture.parentFolder, fixture.childFolder],
				displayPath: `${fixture.parentFolder} > ${fixture.childFolder}`,
			}),
		);
		expect(
			summary.folders.every(
				(folder: { name?: string }) => !folder.name?.includes("/"),
			),
		).toBe(true);

		const confirmed = await runCli([
			"folders",
			"apply-tree",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--confirm",
			"--config",
			fixture.configPath,
		]);
		expect(confirmed.code, confirmed.stderr).toBe(0);
		const dataset = await readJsonFile<{
			folders: { name: string; path: string }[];
		}>(fixture.dataPath);
		expect(dataset.folders).toContainEqual(
			expect.objectContaining({
				name: fixture.destinationB,
				path: fixture.destinationB,
			}),
		);
		expect(dataset.folders).toContainEqual(
			expect.objectContaining({
				name: fixture.childFolder,
				path: `${fixture.parentFolder}/${fixture.childFolder}`,
			}),
		);
	});

	test("plans label creation and guarded deletes from loaded JSON", async () => {
		const fixture = await writeFixture();
		const dryRun = await runCli([
			"labels",
			"plan",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--dry-run",
			"--config",
			fixture.configPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		const summary = JSON.parse(dryRun.stdout);
		expect(summary.actions).toContainEqual({
			action: "create",
			name: fixture.createLabel,
		});
		expect(summary.actions).toContainEqual({
			action: "delete",
			name: fixture.retiredLabel,
			id: "label-retired",
			usage: 1,
		});
		expect(summary.actions).toContainEqual({
			action: "delete",
			name: fixture.unusedLabel,
			id: "label-unused",
			usage: 0,
		});

		const confirmed = await runCli([
			"labels",
			"apply",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--confirm",
			"--config",
			fixture.configPath,
		]);
		expect(confirmed.code, confirmed.stderr).toBe(0);
		const dataset = await readJsonFile<{
			labels: { name: string }[];
			messages: { id: string; labels?: string[] }[];
		}>(fixture.dataPath);
		expect(dataset.labels.map((label) => label.name)).not.toContain(
			fixture.retiredLabel,
		);
		expect(dataset.labels.map((label) => label.name)).not.toContain(
			fixture.unusedLabel,
		);
		expect(
			dataset.messages.find((message) => message.id === "msg-retired-label")
				?.labels,
		).not.toContain(fixture.retiredLabel);
		const labelSnapshot = await readJsonFile<{ labels: { name: string }[] }>(
			join(fixture.dir, "labels.json"),
		);
		expect(labelSnapshot.labels.map((label) => label.name)).toContain(
			fixture.createLabel,
		);
		expect(labelSnapshot.labels.map((label) => label.name)).not.toContain(
			fixture.retiredLabel,
		);
		expect(labelSnapshot.labels.map((label) => label.name)).not.toContain(
			fixture.unusedLabel,
		);
	});

	test("plans filters and routes messages from loaded JSON rules", async () => {
		const fixture = await writeFixture();
		const dryRun = await runCli([
			"filters",
			"plan",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--dry-run",
			"--config",
			fixture.configPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		const summary = JSON.parse(dryRun.stdout);
		expect(summary.actions).toContainEqual(
			expect.objectContaining({
				targetDisplayPath: `${fixture.parentFolder} > ${fixture.childFolder}`,
				estimatedMessages: 1,
			}),
		);
		expect(summary.refusedRules).toHaveLength(1);

		expect(
			(
				await runCli([
					"folders",
					"plan-tree",
					"--provider",
					"outlook",
					"--dir",
					fixture.dir,
					"--data-path",
					fixture.dataPath,
					"--plan-path",
					fixture.planPath,
					"--dry-run",
					"--config",
					fixture.configPath,
				])
			).code,
		).toBe(0);
		expect(
			(
				await runCli([
					"folders",
					"apply-tree",
					"--provider",
					"outlook",
					"--dir",
					fixture.dir,
					"--data-path",
					fixture.dataPath,
					"--plan-path",
					fixture.planPath,
					"--confirm",
					"--config",
					fixture.configPath,
				])
			).code,
		).toBe(0);
		const route = await runCli([
			"inbox",
			"route-plan",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--dry-run",
			"--config",
			fixture.configPath,
		]);
		expect(route.code, route.stderr).toBe(0);
		const routeSummary = JSON.parse(route.stdout);
		expect(
			routeSummary.destinationCounts[
				`${fixture.parentFolder} > ${fixture.childFolder}`
			],
		).toEqual({ total: 1, read: 0, unread: 1 });
		expect(routeSummary.skips).toContainEqual({
			messageId: "msg-review",
			read: false,
			reason: fixture.reviewReason,
		});
		expect(routeSummary.skips).toContainEqual({
			messageId: "msg-unmatched",
			read: false,
			reason: fixture.unmatchedReason,
		});
	});

	test("validate, verify, visualize, review-queue, and plan-patch use loaded JSON artifacts", async () => {
		const fixture = await writeFixture();
		for (const [group, action] of [
			["folders", "plan-tree"],
			["labels", "plan"],
			["filters", "plan"],
			["inbox", "route-plan"],
		] as const) {
			expect(
				(
					await runCli([
						group,
						action,
						"--provider",
						"outlook",
						"--dir",
						fixture.dir,
						"--data-path",
						fixture.dataPath,
						"--plan-path",
						fixture.planPath,
						"--dry-run",
						"--config",
						fixture.configPath,
					])
				).code,
			).toBe(0);
		}
		for (const [group, action] of [
			["folders", "apply-tree"],
			["labels", "apply"],
			["filters", "apply"],
			["inbox", "route-apply"],
		] as const) {
			expect(
				(
					await runCli([
						group,
						action,
						"--provider",
						"outlook",
						"--dir",
						fixture.dir,
						"--data-path",
						fixture.dataPath,
						"--plan-path",
						fixture.planPath,
						"--confirm",
						"--config",
						fixture.configPath,
					])
				).code,
			).toBe(0);
		}

		const validate = await runCli([
			"cleanup",
			"validate",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--config",
			fixture.configPath,
		]);
		expect(validate.code, validate.stderr).toBe(0);
		expect(JSON.parse(validate.stdout)).toMatchObject({
			kind: "mailbox-cleanup-policy-validation",
			valid: true,
		});

		const verify = await runCli([
			"cleanup",
			"verify",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--config",
			fixture.configPath,
		]);
		expect(verify.code, verify.stderr).toBe(0);
		expect(JSON.parse(verify.stdout)).toMatchObject({
			kind: "mailbox-cleanup-verification",
			failed: 0,
		});

		const visualize = await runCli([
			"cleanup",
			"visualize",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--no-open",
			"--no-wait",
			"--config",
			fixture.configPath,
		]);
		expect(visualize.code, visualize.stderr).toBe(0);
		const visualization = JSON.parse(visualize.stdout);
		expect(visualization).toMatchObject({
			kind: "mailbox-cleanup-visualization-summary",
			mutationTarget: "local-artifact",
			opened: false,
			waiting: false,
		});
		expect(visualization.htmlPath.endsWith(".html")).toBe(true);
		const html = await Bun.file(visualization.htmlPath).text();
		expect(html).toContain("Mailbox Cleanup Plan");
		expect(html).toContain("neon-control-surface");
		expect(html).toContain('data-verdict="approve"');
		expect(html).not.toContain("Request changes");
		expect(html).toContain("Add note");
		expect(html).toContain("Advanced JSON");
		expect(html).toContain("Submit approval");
		expect(html).toContain("window.close()");
		expect(html).toContain("policy and report consistency checks");
		expect(html).toContain("Verification is the final consistency check");
		expect(html).toContain("Labels are secondary to Filters");
		expect(html).toContain("Applied labels");
		expect(html).toContain("This is the top-level decision snapshot");
		expect(html).toContain("Routes show where Inbox messages would land");
		expect(html).toContain("Folders define the mailbox destination structure");
		expect(html).toContain("Advanced JSON is for agent handoff");
		expect(html).not.toContain("Prototype A · Overview");
		expect(html).not.toContain("Prototype B · Moves");
		expect(html).not.toContain("Prototype C · Tree");
		expect(html).toContain("Old to new folder tree");
		expect(html).toContain("folder-map-row");
		expect(html).toContain("folder-tree");
		expect(html).toContain("+-- ");
		expect(html).toContain("<strong>Old</strong>");
		expect(html).toContain("<strong>New</strong>");
		expect(html).not.toContain("Prototype A · Counts");
		expect(html).not.toContain("Prototype B · Actions");
		expect(html).not.toContain("Prototype C · Filter use");
		expect(html).not.toContain("Prototype D · Before/after");
		expect(html).toContain("All labels");
		expect(html).toContain(".pill.added");
		expect(html).toContain(".pill.removed");
		expect(html).toContain(".pill.renamed");
		expect(html).toContain("<s>");
		expect(html).toContain("Neutral labels are kept");
		expect(html).not.toContain("<th>Change</th><th>Labels</th>");
		expect(html).not.toContain("data-variant-target");
		expect(html).not.toContain("data-variant-view");
		expect(html).toContain(
			'detail("verification", "Verification", "policy and report consistency checks", renderVerification(), false)',
		);
		expect(html).not.toContain("Copy Review JSON");
		expect(html).not.toContain("navigator.clipboard");
		expect(html).not.toContain("Provider / profile");
		expect(html).not.toContain(
			"verdict = button.dataset.verdict;\\n      renderEvidence();",
		);
		expect(html).toContain("mailbox-cleanup-plan-review");
		expect(
			await readJsonFile<{ template: string }>(visualization.payloadPath),
		).toMatchObject({ template: "plan" });

		const reviewQueue = await runCli([
			"inbox",
			"review-queue",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--config",
			fixture.configPath,
		]);
		expect(reviewQueue.code, reviewQueue.stderr).toBe(0);
		const queueSummary = JSON.parse(reviewQueue.stdout);
		expect(queueSummary.groups[fixture.reviewReason]).toBe(1);
		const queue = await readJsonFile<{ groups: Record<string, unknown[]> }>(
			queueSummary.reportPath,
		);
		expect(queue.groups[fixture.reviewReason]).toHaveLength(1);
		expect(JSON.stringify(queue)).not.toContain("subject");
		expect(JSON.stringify(queue)).not.toContain("@");

		await writeJsonFile(fixture.patchPath, {
			kind: "mailbox-cleanup-plan-patch",
			operations: [
				{
					op: "append",
					path: ["labels", "create"],
					value: fixture.childFolderB,
				},
			],
		});
		const patchDryRun = await runCli([
			"cleanup",
			"plan-patch",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--patch-path",
			fixture.patchPath,
			"--config",
			fixture.configPath,
		]);
		expect(patchDryRun.code, patchDryRun.stderr).toBe(0);
		expect(JSON.parse(patchDryRun.stdout)).toMatchObject({
			changed: true,
			dryRun: true,
		});
		const patchApply = await runCli([
			"cleanup",
			"plan-patch",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--patch-path",
			fixture.patchPath,
			"--confirm",
			"--config",
			fixture.configPath,
		]);
		expect(patchApply.code, patchApply.stderr).toBe(0);
		const plan = await readJsonFile<{ labels: { create: string[] } }>(
			fixture.planPath,
		);
		expect(plan.labels.create).toContain(fixture.childFolderB);
	});

	test("validates cleanup review payload comment requirements", async () => {
		const fixture = await writeFixture();
		const expectation = {
			provider: "outlook" as const,
			dir: fixture.dir,
			mutationTarget: "local-artifact",
			hasVerificationFailures: false,
		};
		const baseReview = {
			kind: "mailbox-cleanup-plan-review",
			provider: "outlook",
			dir: fixture.dir,
			mutationTarget: "local-artifact",
			verdict: "approve",
			comment: "",
			sectionComments: [],
			patch: { kind: "mailbox-cleanup-plan-patch", operations: [] },
		};

		expect(validateCleanupReviewPayload(baseReview, expectation)).toMatchObject(
			{ verdict: "approve", comment: "" },
		);
		expect(() =>
			validateCleanupReviewPayload(
				{ ...baseReview, verdict: "request_changes" },
				expectation,
			),
		).toThrow("approve or reject");
		expect(() =>
			validateCleanupReviewPayload(
				{ ...baseReview, verdict: "reject" },
				expectation,
			),
		).toThrow("comment is required");
		expect(() =>
			validateCleanupReviewPayload(baseReview, {
				...expectation,
				hasVerificationFailures: true,
			}),
		).toThrow("verification failures");
	});

	test("cleanup visualize waits on localhost review submission and writes review JSON", async () => {
		const fixture = await writeFixture();
		for (const [group, action] of [
			["folders", "plan-tree"],
			["labels", "plan"],
			["filters", "plan"],
			["inbox", "route-plan"],
		] as const) {
			expect(
				(
					await runCli([
						group,
						action,
						"--provider",
						"outlook",
						"--dir",
						fixture.dir,
						"--data-path",
						fixture.dataPath,
						"--plan-path",
						fixture.planPath,
						"--dry-run",
						"--config",
						fixture.configPath,
					])
				).code,
			).toBe(0);
		}
		for (const [group, action] of [
			["folders", "apply-tree"],
			["labels", "apply"],
			["filters", "apply"],
			["inbox", "route-apply"],
		] as const) {
			expect(
				(
					await runCli([
						group,
						action,
						"--provider",
						"outlook",
						"--dir",
						fixture.dir,
						"--data-path",
						fixture.dataPath,
						"--plan-path",
						fixture.planPath,
						"--confirm",
						"--config",
						fixture.configPath,
					])
				).code,
			).toBe(0);
		}
		expect(
			(
				await runCli([
					"cleanup",
					"verify",
					"--provider",
					"outlook",
					"--dir",
					fixture.dir,
					"--data-path",
					fixture.dataPath,
					"--plan-path",
					fixture.planPath,
					"--config",
					fixture.configPath,
				])
			).code,
		).toBe(0);

		const running = await runCliInBackground([
			"cleanup",
			"visualize",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--no-open",
			"--review-timeout",
			"10",
			"--config",
			fixture.configPath,
		]);
		expect(running.summary).toMatchObject({
			kind: "mailbox-cleanup-review-waiting",
			opened: false,
		});
		expect(running.summary.reviewUrl).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/review$/,
		);
		const response = await postJsonWithRetry(running.summary.reviewUrl, {
			kind: "mailbox-cleanup-plan-review",
			provider: "outlook",
			dir: fixture.dir,
			mutationTarget: "local-artifact",
			verdict: "reject",
			comment: "Add a safer folder note.",
			sectionComments: [{ section: "filters", comment: "Tighten one filter." }],
			patch: {
				kind: "mailbox-cleanup-plan-patch",
				operations: [
					{
						op: "append",
						path: ["labels", "create"],
						value: fixture.childFolderB,
					},
				],
			},
		});
		expect(response.status).toBe(200);
		const finished = await running.finish();
		expect(finished.code).toBe(1);
		expect(finished.stderr).toContain("Cleanup review rejected");
		const lines = finished.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.at(-1)).toMatchObject({
			kind: "mailbox-cleanup-review-summary",
			verdict: "reject",
			sectionComments: 1,
			patchOperations: 1,
		});
		expect(lines.at(-1).remadePlanPaths).toHaveLength(4);
		expect(lines.at(-1).remadeDryRunPaths).toHaveLength(4);
		const review = await readJsonFile<{
			verdict: string;
			sectionComments: unknown[];
		}>(join(fixture.dir, "reports", "outlook-cleanup-review.json"));
		expect(review.verdict).toBe("reject");
		expect(review.sectionComments).toHaveLength(1);
		expect(
			existsSync(
				join(fixture.dir, "reports", "outlook-inbox-route-dry-run.json"),
			),
		).toBe(true);
	});

	test("confirm refuses missing or stale dry-run fingerprints", async () => {
		const fixture = await writeFixture();
		const missingDryRun = await runCli([
			"folders",
			"apply-tree",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--confirm",
			"--config",
			fixture.configPath,
		]);
		expect(missingDryRun.code).toBe(1);
		expect(missingDryRun.stderr).toContain("matching dry-run report");

		expect(
			(
				await runCli([
					"folders",
					"plan-tree",
					"--provider",
					"outlook",
					"--dir",
					fixture.dir,
					"--data-path",
					fixture.dataPath,
					"--plan-path",
					fixture.planPath,
					"--dry-run",
					"--config",
					fixture.configPath,
				])
			).code,
		).toBe(0);
		const dataset = await readJsonFile<{ folders: unknown[] }>(
			fixture.dataPath,
		);
		dataset.folders.push({
			id: "late-folder",
			name: fixture.parentFolder,
			path: fixture.parentFolder,
			type: "folder",
		});
		await writeJsonFile(fixture.dataPath, dataset);
		const stale = await runCli([
			"folders",
			"apply-tree",
			"--provider",
			"outlook",
			"--dir",
			fixture.dir,
			"--data-path",
			fixture.dataPath,
			"--plan-path",
			fixture.planPath,
			"--confirm",
			"--config",
			fixture.configPath,
		]);
		expect(stale.code).toBe(1);
		expect(stale.stderr).toContain("unchanged plan fingerprint");
		expect(
			existsSync(
				join(fixture.dir, "reports", "outlook-folder-tree-dry-run.json"),
			),
		).toBe(true);
	});

	test("validates spec frontmatter without external yaml tooling", async () => {
		const specPath = tmpPath("cleanup-spec.md");
		await Bun.$`mkdir -p ${dirname(specPath)}`.quiet();
		await Bun.write(
			specPath,
			`---
id: synthetic-cleanup-spec
status: in-progress
slices:
  - id: s0-synthetic
    name: synthetic-slice
    depends_on: []
    files: ["src/**"]
    agents:
      primary: js
      qa: [qa-code, security]
---

# Synthetic Cleanup Spec
`,
		);
		const result = await runCli(["validate", "spec", "--spec-path", specPath]);
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			kind: "spec-validation-summary",
			valid: true,
			slices: 1,
		});
	});
});
