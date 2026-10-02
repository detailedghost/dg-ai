import { fixturePath, fixtureConfigPath } from "./fixture-paths";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "../src/cli/args";
import { createCliContext } from "../src/cli/context";
import { main } from "../src/cli/index";
import type { MailProviderClient } from "../src/providers/types";
import {
	applyWorkspaceMutations,
	dryRunWorkspaceApply,
	workspacePaths,
	writeFilters,
	writeFolders,
	writeMessageWorkItems,
} from "../src/workspace/store";
import type { MessageWorkItem } from "../src/workspace/types";

const configArgs = ["--config", fixtureConfigPath];
const dataPathArgs = ["--data-path", fixturePath("proton-dataset.json")];

async function runCli(
	args: string[],
	options: { config?: boolean; dataPath?: boolean } = {},
) {
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
			...(options.config === false ? [] : configArgs),
			...(options.dataPath ? dataPathArgs : []),
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

function tmpPath(name: string): string {
	return `/tmp/email-organizer-tests-${crypto.randomUUID()}/${name}`;
}

async function copyFixtureDataset(path: string): Promise<void> {
	await Bun.$`mkdir -p ${dirname(path)}`.quiet();
	await Bun.write(
		path,
		await Bun.file(fixturePath("proton-dataset.json")).text(),
	);
}

async function writeDataset(path: string, dataset: unknown): Promise<void> {
	await Bun.$`mkdir -p ${dirname(path)}`.quiet();
	await Bun.write(path, `${JSON.stringify(dataset, null, 2)}\n`);
}

describe("CLI", () => {
	test("runs local workspace cleanup workflow with redacted per-message files", async () => {
		const dir = tmpPath("workspace");
		const dataPath = tmpPath("proton-dataset.json");
		await copyFixtureDataset(dataPath);

		const init = await runCli([
			"init",
			"--username",
			"jane@example.com",
			"--dir",
			dir,
		]);
		expect(init.code, init.stderr).toBe(0);
		expect(JSON.parse(init.stdout)).toMatchObject({
			kind: "workspace-init",
			dir,
		});
		expect(existsSync(`${dir}/login.json`)).toBe(true);
		expect(await Bun.file(`${dir}/login.json`).text()).not.toContain(
			"password",
		);
		expect(await Bun.file(`${dir}/login.json`).text()).not.toContain("token");

		const folders = await runCli([
			"load",
			"folders",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(folders.code, folders.stderr).toBe(0);
		expect(JSON.parse(folders.stdout)).toMatchObject({
			kind: "workspace-load-folders",
			count: 4,
		});
		expect(existsSync(`${dir}/folders.json`)).toBe(true);

		const filters = await runCli([
			"load",
			"filters",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(filters.code, filters.stderr).toBe(0);
		expect(JSON.parse(filters.stdout)).toMatchObject({
			kind: "workspace-load-filters",
			count: 1,
			redacted: true,
		});
		expect(await Bun.file(`${dir}/filters.json`).text()).not.toContain(
			"jane@example.com",
		);

		const probe = await runCli([
			"probe",
			"--dir",
			dir,
			"--folder",
			"inbox",
			"--limit",
			"3",
			"--group-limit",
			"2",
			"--data-path",
			dataPath,
		]);
		expect(probe.code, probe.stderr).toBe(0);
		const probeOutput = JSON.parse(probe.stdout);
		expect(probeOutput).toMatchObject({
			kind: "workspace-probe",
			dryRun: true,
			mutated: false,
			fetched: 3,
			reachedLimit: true,
			folder: {
				requested: "inbox",
				id: "inbox",
				name: "Inbox",
				snapshotTotal: 3,
				snapshotUnread: 1,
			},
		});
		expect(probeOutput.topDomains).toHaveLength(2);
		expect(JSON.stringify(probeOutput)).not.toContain("billing@stripe.com");

		const guide = await runCli([
			"classify-doc",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(guide.code, guide.stderr).toBe(0);
		expect(JSON.parse(guide.stdout)).toMatchObject({
			kind: "workspace-classification-guide",
		});
		expect(await Bun.file(`${dir}/classification.json`).text()).toContain(
			"fastest/cheapest",
		);
		expect(await Bun.file(`${dir}/classification.json`).text()).toContain(
			"markRead",
		);

		const batch = await runCli([
			"batch",
			"--dir",
			dir,
			"--folder",
			"inbox",
			"--limit",
			"3000",
			"--concurrency",
			"2",
			"--data-path",
			dataPath,
		]);
		expect(batch.code, batch.stderr).toBe(0);
		expect(JSON.parse(batch.stdout)).toMatchObject({
			kind: "workspace-batch",
			total: 3,
			concurrency: 2,
		});

		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		expect(status).toMatchObject({ kind: "message-status-index", total: 3 });
		expect(status.counts.fetched).toBe(3);
		expect(status.items).toHaveLength(3);

		const firstMessagePath = `${dir}/${status.items[0].file}`;
		const firstMessage = await Bun.file(firstMessagePath).text();
		expect(firstMessage).toContain('"kind": "message-work-item"');
		expect(firstMessage).not.toContain("jane@example.com");
		expect(firstMessage).not.toContain("987654");
		expect(firstMessage).not.toContain("billing@stripe.com");
		const firstMessageJson = await Bun.file(firstMessagePath).json();
		firstMessageJson.status = "classified";
		firstMessageJson.statusUpdatedAt = new Date().toISOString();
		firstMessageJson.decision = {
			action: "move",
			targetFolder: "Receipts",
			markRead: true,
			confidence: 0.95,
			reason:
				"Receipt-style message should be organized into Receipts and marked read.",
			filterGap: "Existing receipt filter did not cover this sender.",
		};
		await Bun.write(
			firstMessagePath,
			`${JSON.stringify(firstMessageJson, null, 2)}\n`,
		);

		const statusProc = await runCli([
			"status",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(statusProc.code, statusProc.stderr).toBe(0);
		const statusSummary = JSON.parse(statusProc.stdout);
		expect(statusSummary).toMatchObject({ total: 3, full: false });
		expect(statusSummary.items).toBeUndefined();

		const fullStatusProc = await runCli([
			"status",
			"--dir",
			dir,
			"--full",
			"--data-path",
			dataPath,
		]);
		expect(fullStatusProc.code, fullStatusProc.stderr).toBe(0);
		expect(JSON.parse(fullStatusProc.stdout).items).toHaveLength(3);

		const review = await runCli([
			"review",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(review.code, review.stderr).toBe(0);
		expect(JSON.parse(review.stdout).review).toMatchObject({
			readyToMove: 1,
			readyToMarkRead: 1,
		});
		expect(existsSync(`${dir}/plans/review.json`)).toBe(true);

		const dryRun = await runCli([
			"apply",
			"--dir",
			dir,
			"--dry-run",
			"--data-path",
			dataPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		expect(JSON.parse(dryRun.stdout)).toMatchObject({
			kind: "workspace-apply-summary",
			dryRun: true,
			mutated: false,
			ready: 1,
			markRead: 1,
		});

		const refusedApply = await runCli([
			"apply",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(refusedApply.code).toBe(1);
		expect(refusedApply.stderr).toContain("requires --dry-run or --confirm");

		const confirmedApply = await runCli([
			"apply",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(confirmedApply.code, confirmedApply.stderr).toBe(0);
		const confirmedSummary = JSON.parse(confirmedApply.stdout);
		expect(confirmedSummary).toMatchObject({
			kind: "workspace-apply-summary",
			dryRun: false,
			mutated: true,
			moved: 1,
			markRead: 1,
		});
		expect(existsSync(confirmedSummary.auditPath)).toBe(true);
		const auditText = await Bun.file(confirmedSummary.auditPath).text();
		expect(auditText).not.toContain("msg-1");
		expect(auditText).toContain("source_hash_");
		const mutatedDataset = await Bun.file(dataPath).json();
		expect(mutatedDataset.messages[0]).toMatchObject({
			folderId: "receipts",
			folderName: "Receipts",
			read: true,
		});
		const appliedMessage = await Bun.file(firstMessagePath).json();
		expect(appliedMessage).toMatchObject({
			status: "applied",
			currentFolder: "Receipts",
		});
		expect(
			(await Bun.file(`${dir}/messages/_status.json`).json()).counts.applied,
		).toBe(1);

		const summary = await runCli([
			"summary",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(summary.code, summary.stderr).toBe(0);
		const summaryOutput = JSON.parse(summary.stdout);
		expect(summaryOutput).toMatchObject({
			kind: "workspace-summary",
			dir,
			status: { total: 3 },
			decisions: {
				actions: { move: 1, none: 2 },
				markRead: 1,
			},
			review: {
				total: 3,
				readyToMove: 1,
				readyToMarkRead: 1,
				needsReview: 0,
			},
			apply: {
				total: 3,
				moved: 1,
				markRead: 1,
				review: 0,
				skipped: 0,
			},
			latestAudit: {
				moved: 1,
				markedRead: 1,
			},
		});
		expect(summaryOutput.decisions.targetFolders).toContainEqual({
			folder: "Receipts",
			count: 1,
		});
		expect(summaryOutput.latestAudit.movedByFolder).toContainEqual({
			folder: "Receipts",
			count: 1,
		});
		expect(JSON.stringify(summaryOutput)).not.toContain("msg-1");

		const datasetAfterApply = await Bun.file(dataPath).text();
		const repeatedApply = await runCli([
			"apply",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(repeatedApply.code).toBe(1);
		expect(repeatedApply.stderr).toMatch(
			/changed.*dry.run|stale|dry.run.*changed/i,
		);
		expect(await Bun.file(dataPath).text()).toBe(datasetAfterApply);
		const repeatedDryRun = await runCli([
			"apply",
			"--dir",
			dir,
			"--dry-run",
			"--data-path",
			dataPath,
		]);
		expect(repeatedDryRun.code, repeatedDryRun.stderr).toBe(0);
		expect(JSON.parse(repeatedDryRun.stdout)).toMatchObject({
			ready: 0,
			markRead: 0,
		});
		const refreshedApply = await runCli([
			"apply",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(refreshedApply.code, refreshedApply.stderr).toBe(0);
		expect(JSON.parse(refreshedApply.stdout)).toMatchObject({
			moved: 0,
			markRead: 0,
		});
		expect(await Bun.file(dataPath).text()).toBe(datasetAfterApply);

		const refusedCleanup = await runCli([
			"cleanup",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(refusedCleanup.code).toBe(1);
		expect(refusedCleanup.stdout).toContain("WARNING");
		expect(existsSync(`${dir}/messages/_status.json`)).toBe(true);

		const cleanup = await runCli([
			"cleanup",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(cleanup.code, cleanup.stderr).toBe(0);
		expect(JSON.parse(cleanup.stdout)).toMatchObject({
			kind: "workspace-cleanup",
			preserved: `${dir}/login.json`,
		});
		expect(existsSync(`${dir}/login.json`)).toBe(true);
		expect(existsSync(`${dir}/messages/_status.json`)).toBe(false);
		expect(existsSync(`${dir}/folders.json`)).toBe(false);
	});

	test("--data-path overrides config for workspace loads", async () => {
		const dir = tmpPath("override-workspace");
		const folders = await runCli(
			[
				"load",
				"folders",
				"--dir",
				dir,
				"--config",
				"/tmp/email-organizer-missing-config.json",
			],
			{ config: false, dataPath: true },
		);
		expect(folders.code, folders.stderr).toBe(0);
		expect(JSON.parse(folders.stdout)).toMatchObject({
			kind: "workspace-load-folders",
			count: 4,
		});
	});

	test("analyzes, samples, suggests, and writes local decisions without live mutation", async () => {
		const dir = tmpPath("decision-workspace");
		const dataPath = tmpPath("proton-dataset.json");
		await copyFixtureDataset(dataPath);

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(await runCli(["load", "filters", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"3",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);

		const analyze = await runCli([
			"analyze",
			"--dir",
			dir,
			"--by",
			"domain",
			"--limit",
			"3",
		]);
		expect(analyze.code, analyze.stderr).toBe(0);
		const analysis = JSON.parse(analyze.stdout);
		expect(analysis).toMatchObject({
			kind: "workspace-analysis",
			by: "domain",
			total: 3,
		});
		expect(analysis.groups).toContainEqual(
			expect.objectContaining({ key: "stripe.com", count: 1 }),
		);
		expect(JSON.stringify(analysis)).not.toContain("msg-1");

		const sample = await runCli([
			"sample",
			"--dir",
			dir,
			"--domain",
			"stripe.com",
			"--limit",
			"1",
		]);
		expect(sample.code, sample.stderr).toBe(0);
		const sampleOutput = JSON.parse(sample.stdout);
		expect(sampleOutput).toMatchObject({ kind: "workspace-sample", total: 1 });
		expect(sampleOutput.samples[0]).toMatchObject({
			fromDomain: "stripe.com",
			subject: "Receipt for payment [number]",
		});
		expect(JSON.stringify(sampleOutput)).not.toContain("billing@stripe.com");

		const suggest = await runCli(["suggest", "--dir", dir, "--limit", "3"]);
		expect(suggest.code, suggest.stderr).toBe(0);
		const suggestions = JSON.parse(suggest.stdout);
		expect(suggestions).toMatchObject({
			kind: "workspace-suggestions",
			total: 3,
			write: false,
		});
		expect(suggestions.counts.move).toBeGreaterThan(0);
		expect(suggestions.targetFolders).toContainEqual({
			folder: "Receipts",
			count: 1,
		});
		expect(
			suggestions.proposals.some(
				(proposal: { targetFolder?: string }) =>
					proposal.targetFolder === "Receipts",
			),
		).toBe(true);

		const writeSuggestions = await runCli([
			"suggest",
			"--dir",
			dir,
			"--limit",
			"3",
			"--write",
		]);
		expect(writeSuggestions.code, writeSuggestions.stderr).toBe(0);
		expect(JSON.parse(writeSuggestions.stdout)).toMatchObject({
			kind: "workspace-suggestions",
			write: true,
			written: 3,
		});

		const statusAfterSuggest = await Bun.file(
			`${dir}/messages/_status.json`,
		).json();
		expect(statusAfterSuggest.counts.classified).toBe(3);
		const firstMessage = await Bun.file(
			`${dir}/${statusAfterSuggest.items[0].file}`,
		).json();
		expect(firstMessage.decision).toMatchObject({
			action: "move",
			targetFolder: "Receipts",
			markRead: true,
		});

		const decideReview = await runCli([
			"decide",
			"--dir",
			dir,
			"--domain",
			"stripe.com",
			"--action",
			"review",
			"--reason",
			"Manual review requested.",
		]);
		expect(decideReview.code, decideReview.stderr).toBe(0);
		expect(JSON.parse(decideReview.stdout)).toMatchObject({
			kind: "workspace-decisions-written",
			matched: 1,
			written: 1,
			action: "review",
		});
		const reviewedMessage = await Bun.file(
			`${dir}/${statusAfterSuggest.items[0].file}`,
		).json();
		expect(reviewedMessage.decision).toMatchObject({
			action: "review",
			reason: "Manual review requested.",
		});
		expect(reviewedMessage.decision.markRead).toBeUndefined();
	});

	test("decide refuses invalid target folders before writing any local decisions", async () => {
		const dir = tmpPath("invalid-decision-workspace");
		const dataPath = tmpPath("proton-dataset.json");
		await copyFixtureDataset(dataPath);

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"1",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);

		const refused = await runCli([
			"decide",
			"--dir",
			dir,
			"--domain",
			"stripe.com",
			"--action",
			"move",
			"--target-folder",
			"Missing",
		]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("target folder not found");
		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		const message = await Bun.file(`${dir}/${status.items[0].file}`).json();
		expect(message.decision).toBeUndefined();
		expect(message.status).toBe("fetched");
	});

	test("decide restricts a move to an explicit --ids-file set", async () => {
		const dir = tmpPath("ids-file-workspace");
		const dataPath = tmpPath("proton-dataset.json");
		await copyFixtureDataset(dataPath);

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"3",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);

		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		expect(status.items.length).toBeGreaterThanOrEqual(2);
		const targetId = status.items[0].id;
		const idsFile = tmpPath("selected-ids.txt");
		await Bun.$`mkdir -p ${dirname(idsFile)}`.quiet();
		await Bun.write(idsFile, `# reviewed set\n${targetId}\n`);

		const decided = await runCli([
			"decide",
			"--dir",
			dir,
			"--action",
			"move",
			"--target-folder",
			"Receipts",
			"--ids-file",
			idsFile,
		]);
		expect(decided.code, decided.stderr).toBe(0);
		expect(JSON.parse(decided.stdout)).toMatchObject({
			kind: "workspace-decisions-written",
			matched: 1,
			written: 1,
			action: "move",
		});

		const after = await Bun.file(`${dir}/messages/_status.json`).json();
		expect(
			after.items.filter(
				(item: { decision?: { action: string } }) =>
					item.decision?.action === "move",
			),
		).toHaveLength(1);
		const moved = after.items.find(
			(item: { id: string }) => item.id === targetId,
		);
		expect(moved.decision).toMatchObject({
			action: "move",
			targetFolder: "Receipts",
		});
	});

	test("folder inventory exposes subfolder paths and ambiguous leaf names require exact paths", async () => {
		const dir = tmpPath("subfolder-workspace");
		const dataPath = tmpPath("subfolder-dataset.json");
		await writeDataset(dataPath, {
			folders: [
				{ id: "inbox", name: "Inbox", type: "system", total: 1, unread: 1 },
				{
					id: "finance",
					name: "Finance",
					type: "folder",
					path: "Finance",
					total: 0,
					unread: 0,
				},
				{
					id: "finance-receipts",
					name: "Receipts",
					type: "folder",
					path: "Finance/Receipts",
					total: 1,
					unread: 0,
				},
				{
					id: "shopping-receipts",
					name: "Receipts",
					type: "folder",
					path: "Shopping/Receipts",
					total: 0,
					unread: 0,
				},
			],
			filters: [],
			messages: [
				{
					id: "nested-msg-1",
					from: "orders@example.com",
					subject: "Receipt for payment 555",
					snippet: "Thanks for your purchase.",
					folderId: "finance-receipts",
					folderName: "Receipts",
					read: false,
					receivedAt: "2026-06-04T12:00:00Z",
				},
			],
		});

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);

		const inventory = await runCli(["folders", "inventory", "--dir", dir]);
		expect(inventory.code, inventory.stderr).toBe(0);
		const inventoryOutput = JSON.parse(inventory.stdout);
		expect(inventoryOutput).toMatchObject({
			kind: "workspace-folder-inventory",
			total: 4,
			recursiveSourceScan: false,
		});
		expect(inventoryOutput.folders).toContainEqual(
			expect.objectContaining({
				id: "finance-receipts",
				name: "Receipts",
				path: "Finance/Receipts",
				parentPath: "Finance",
				depth: 1,
			}),
		);
		expect(inventoryOutput.ambiguousNames).toContainEqual({
			name: "Receipts",
			matches: [
				{ id: "finance-receipts", path: "Finance/Receipts" },
				{ id: "shopping-receipts", path: "Shopping/Receipts" },
			],
		});

		const ambiguousBatch = await runCli([
			"batch",
			"--dir",
			dir,
			"--folder",
			"Receipts",
			"--limit",
			"1",
			"--data-path",
			dataPath,
		]);
		expect(ambiguousBatch.code).toBe(1);
		expect(ambiguousBatch.stderr).toContain("Ambiguous folder");

		const pathBatch = await runCli([
			"batch",
			"--dir",
			dir,
			"--folder",
			"Finance/Receipts",
			"--limit",
			"1",
			"--data-path",
			dataPath,
		]);
		expect(pathBatch.code, pathBatch.stderr).toBe(0);
		expect(JSON.parse(pathBatch.stdout)).toMatchObject({
			kind: "workspace-batch",
			total: 1,
		});

		const ambiguousDecision = await runCli([
			"decide",
			"--dir",
			dir,
			"--action",
			"move",
			"--target-folder",
			"Receipts",
		]);
		expect(ambiguousDecision.code).toBe(1);
		expect(ambiguousDecision.stderr).toContain("Ambiguous folder");

		const pathDecision = await runCli([
			"decide",
			"--dir",
			dir,
			"--action",
			"move",
			"--target-folder",
			"Shopping/Receipts",
		]);
		expect(pathDecision.code, pathDecision.stderr).toBe(0);
		expect(JSON.parse(pathDecision.stdout)).toMatchObject({
			targetFolder: "Shopping/Receipts",
			written: 1,
		});
	});

	test("filter recommendations flag mixed domains and can rewrite archive decisions to subfolders locally", async () => {
		const dir = tmpPath("filter-recommendation-workspace");
		const dataPath = tmpPath("filter-recommendation-dataset.json");
		await writeDataset(dataPath, {
			folders: [
				{ id: "inbox", name: "Inbox", type: "system", total: 5, unread: 0 },
				{ id: "archive", name: "Archive", type: "system", total: 0, unread: 0 },
				{
					id: "receipts",
					name: "receipt",
					type: "folder",
					path: "Finance/receipt",
					total: 0,
					unread: 0,
				},
				{
					id: "bank",
					name: "bank",
					type: "folder",
					path: "Finance/bank",
					total: 0,
					unread: 0,
				},
				{ id: "spam", name: "Spam", type: "system", total: 0, unread: 0 },
			],
			filters: [],
			messages: [
				{
					id: "archive-receipt-1",
					from: "notice@mixed.example",
					subject: "Receipt for payment 111",
					snippet: "Your purchase was delivered.",
					folderId: "inbox",
					folderName: "Inbox",
					read: true,
				},
				{
					id: "bank-1",
					from: "notice@mixed.example",
					subject: "Monthly statement",
					snippet: "Your bank statement is ready.",
					folderId: "inbox",
					folderName: "Inbox",
					read: true,
				},
				{
					id: "spam-1",
					from: "promo@junk.example",
					subject: "Limited offer",
					snippet: "Promotional mail.",
					folderId: "inbox",
					folderName: "Inbox",
					read: true,
				},
				{
					id: "safe-bank-archive",
					from: "notice@safebank.example",
					subject: "Account update",
					snippet: "A general account message.",
					folderId: "inbox",
					folderName: "Inbox",
					read: true,
				},
				{
					id: "safe-bank-moved",
					from: "notice@safebank.example",
					subject: "Monthly statement",
					snippet: "Your bank statement is ready.",
					folderId: "inbox",
					folderName: "Inbox",
					read: true,
				},
			],
		});

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"5",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);

		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		for (const statusItem of status.items) {
			const path = `${dir}/${statusItem.file}`;
			const item = await Bun.file(path).json();
			item.status = "applied";
			item.statusUpdatedAt = new Date().toISOString();
			if (item.sourceMessageId === "archive-receipt-1") {
				item.currentFolder = "Archive";
				item.packet.currentFolder = "Archive";
				item.decision = {
					action: "move",
					targetFolder: "Archive",
					markRead: true,
					reason: "Previously routed to Archive.",
				};
			} else if (item.sourceMessageId === "bank-1") {
				item.currentFolder = "Finance/bank";
				item.packet.currentFolder = "Finance/bank";
				item.decision = {
					action: "move",
					targetFolder: "Finance/bank",
					markRead: true,
					reason: "Bank message.",
				};
			} else if (item.sourceMessageId === "safe-bank-archive") {
				item.currentFolder = "Archive";
				item.packet.currentFolder = "Archive";
				item.decision = {
					action: "move",
					targetFolder: "Archive",
					markRead: true,
					reason: "Previously routed to Archive.",
				};
			} else if (item.sourceMessageId === "safe-bank-moved") {
				item.currentFolder = "Finance/bank";
				item.packet.currentFolder = "Finance/bank";
				item.decision = {
					action: "move",
					targetFolder: "Finance/bank",
					markRead: true,
					reason: "Bank message.",
				};
			} else {
				item.currentFolder = "Spam";
				item.packet.currentFolder = "Spam";
				item.decision = {
					action: "move",
					targetFolder: "Spam",
					markRead: true,
					reason: "Junk message.",
				};
			}
			await Bun.write(path, `${JSON.stringify(item, null, 2)}\n`);
		}

		const recommend = await runCli(["recommend", "filters", "--dir", dir]);
		expect(recommend.code, recommend.stderr).toBe(0);
		const output = JSON.parse(recommend.stdout);
		expect(output).toMatchObject({
			kind: "workspace-filter-recommendations",
			liveMutation: false,
			automaticApply: false,
		});
		expect(output.filterRecommendations).toContainEqual(
			expect.objectContaining({
				domain: "mixed.example",
				targetFolder: "Finance/bank",
				safeForDomainFilter: false,
			}),
		);
		expect(output.filterRecommendations).toContainEqual(
			expect.objectContaining({
				domain: "junk.example",
				targetFolder: "Spam",
				safeForDomainFilter: true,
			}),
		);
		expect(output.archiveFollowups).toContainEqual(
			expect.objectContaining({
				domain: "mixed.example",
				sourceFolder: "Archive",
				targetFolder: "Finance/receipt",
				safeForDomainFilter: false,
			}),
		);
		expect(output.archiveFollowups).toContainEqual(
			expect.objectContaining({
				domain: "safebank.example",
				sourceFolder: "Archive",
				targetFolder: "Finance/bank",
				safeForDomainFilter: true,
			}),
		);
		expect(output.informational).toContainEqual(
			expect.objectContaining({ targetFolder: "Archive", count: 2 }),
		);
		expect(existsSync(`${dir}/plans/filter-recommendations.json`)).toBe(true);

		const rewrite = await runCli([
			"recommend",
			"filters",
			"--dir",
			dir,
			"--write-archive-decisions",
		]);
		expect(rewrite.code, rewrite.stderr).toBe(0);
		expect(JSON.parse(rewrite.stdout)).toMatchObject({
			writeArchiveDecisions: true,
			archiveDecisionUpdates: 1,
		});
		const after = await Promise.all(
			status.items.map((item: { file: string }) =>
				Bun.file(`${dir}/${item.file}`).json(),
			),
		);
		expect(
			after.find((item) => item.sourceMessageId === "safe-bank-archive")
				?.decision,
		).toMatchObject({
			action: "move",
			targetFolder: "Finance/bank",
			markRead: true,
		});
		expect(
			after.find((item) => item.sourceMessageId === "archive-receipt-1")
				?.decision,
		).toMatchObject({
			action: "move",
			targetFolder: "Archive",
		});

		const review = await runCli([
			"review",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(review.code, review.stderr).toBe(0);
		expect(JSON.parse(review.stdout).review).toMatchObject({
			total: 5,
			readyToMove: 1,
			readyToMarkRead: 1,
		});

		const dryRun = await runCli([
			"apply",
			"--dir",
			dir,
			"--dry-run",
			"--data-path",
			dataPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		expect(JSON.parse(dryRun.stdout)).toMatchObject({ ready: 1, markRead: 1 });
	});

	test("decide can select existing review decisions for bulk cleanup", async () => {
		const dir = tmpPath("review-decision-workspace");
		const dataPath = tmpPath("proton-dataset.json");
		await copyFixtureDataset(dataPath);

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"3",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);
		expect(
			(
				await runCli([
					"decide",
					"--dir",
					dir,
					"--domain",
					"stripe.com",
					"--action",
					"review",
					"--reason",
					"Needs manual review.",
				])
			).code,
		).toBe(0);

		const moveReviewed = await runCli([
			"decide",
			"--dir",
			dir,
			"--decision-action",
			"review",
			"--action",
			"move",
			"--target-folder",
			"Receipts",
			"--reason",
			"Clean remaining reviewed inbox items.",
		]);
		expect(moveReviewed.code, moveReviewed.stderr).toBe(0);
		expect(JSON.parse(moveReviewed.stdout)).toMatchObject({
			matched: 1,
			written: 1,
			action: "move",
			targetFolder: "Receipts",
		});

		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		const decided = await Promise.all(
			status.items.map((item: { file: string }) =>
				Bun.file(`${dir}/${item.file}`).json(),
			),
		);
		expect(
			decided.filter((item) => item.decision?.targetFolder === "Receipts"),
		).toHaveLength(1);
		expect(
			decided.filter((item) => item.decision?.markRead === true),
		).toHaveLength(1);
	});

	test("decide can route domain substrings while preserving already-correct targets", async () => {
		const dir = tmpPath("domain-policy-workspace");
		const dataPath = tmpPath("domain-policy-dataset.json");
		await writeDataset(dataPath, {
			folders: [
				{ id: "inbox", name: "Inbox", type: "system", total: 2, unread: 0 },
				{
					id: "credit-card",
					name: "credit-card",
					type: "label",
					total: 0,
					unread: 0,
				},
				{ id: "invoice", name: "invoice", type: "label", total: 0, unread: 0 },
			],
			filters: [],
			messages: [
				{
					id: "capitalone-wrong",
					from: "alerts@notification.capitalone.com",
					subject: "Statement",
					snippet: "Your invoice is ready.",
					folderId: "inbox",
					folderName: "Inbox",
					read: true,
				},
				{
					id: "capitalone-right",
					from: "alerts@message.capitalone.com",
					subject: "Card notice",
					snippet: "Your card message is ready.",
					folderId: "inbox",
					folderName: "Inbox",
					read: true,
				},
			],
		});
		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"2",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);
		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		for (const statusItem of status.items) {
			const path = `${dir}/${statusItem.file}`;
			const item = await Bun.file(path).json();
			item.status = "applied";
			item.decision = {
				action: "move",
				targetFolder:
					item.sourceMessageId === "capitalone-wrong"
						? "invoice"
						: "credit-card",
				markRead: true,
			};
			await Bun.write(path, `${JSON.stringify(item, null, 2)}\n`);
		}

		const policy = await runCli([
			"decide",
			"--dir",
			dir,
			"--domain-contains",
			"capitalone",
			"--action",
			"move",
			"--target-folder",
			"credit-card",
			"--only-target-mismatch",
			"--reason",
			"Capital One policy.",
		]);
		expect(policy.code, policy.stderr).toBe(0);
		expect(JSON.parse(policy.stdout)).toMatchObject({
			matched: 1,
			written: 1,
			targetFolder: "credit-card",
		});
		const after = await Promise.all(
			status.items.map((item: { file: string }) =>
				Bun.file(`${dir}/${item.file}`).json(),
			),
		);
		expect(
			after.find((item) => item.sourceMessageId === "capitalone-wrong"),
		).toMatchObject({
			status: "classified",
			decision: { targetFolder: "credit-card" },
		});
		expect(
			after.find((item) => item.sourceMessageId === "capitalone-right"),
		).toMatchObject({
			status: "applied",
			decision: { targetFolder: "credit-card" },
		});
	});

	test("filters apply dry-runs and confirms safe domain-only filter recommendations", async () => {
		const dir = tmpPath("filter-apply-workspace");
		const dataPath = tmpPath("filter-apply-dataset.json");
		await writeDataset(dataPath, {
			folders: [
				{ id: "inbox", name: "Inbox", type: "system", total: 0, unread: 0 },
				{
					id: "receipts",
					name: "Receipts",
					type: "folder",
					total: 0,
					unread: 0,
				},
				{ id: "spam", name: "Spam", type: "system", total: 0, unread: 0 },
			],
			filters: [
				{
					id: "existing-filter",
					name: "Email Organizer: message.capitalone.com -> Receipts",
					enabled: true,
					conditions: ["message.capitalone.com"],
					actions: ["fileinto Receipts"],
				},
			],
			messages: [],
		});
		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(await runCli(["load", "filters", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		await Bun.$`mkdir -p ${dir}/plans`.quiet();
		await Bun.write(
			`${dir}/plans/filter-recommendations.json`,
			`${JSON.stringify(
				{
					kind: "workspace-filter-recommendations",
					filterRecommendations: [
						{
							domain: "stripe.com",
							targetFolder: "Receipts",
							count: 12,
							safeForDomainFilter: true,
						},
						{
							domain: "message.capitalone.com",
							targetFolder: "Receipts",
							count: 5,
							safeForDomainFilter: true,
						},
						{
							domain: "mixed.example.com",
							targetFolder: "Receipts",
							count: 3,
							safeForDomainFilter: false,
							warning: "Mixed target domain.",
						},
						{
							domain: "archive.example.com",
							targetFolder: "Archive",
							count: 2,
							safeForDomainFilter: true,
						},
					],
					archiveFollowups: [
						{
							domain: "spam.example.com",
							targetFolder: "Spam",
							count: 4,
							safeForDomainFilter: true,
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const refused = await runCli([
			"filters",
			"apply",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(
			"requires a successful filters apply --dry-run report",
		);

		const dryRun = await runCli([
			"filters",
			"apply",
			"--dir",
			dir,
			"--dry-run",
			"--data-path",
			dataPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		const dryRunOutput = JSON.parse(dryRun.stdout);
		expect(dryRunOutput).toMatchObject({
			kind: "workspace-filter-apply-summary",
			dryRun: true,
			mutated: false,
			eligible: 3,
			create: 2,
			existing: 1,
			blocked: 2,
		});
		expect(dryRunOutput.filters).toContainEqual(
			expect.objectContaining({
				domain: "stripe.com",
				targetFolder: "Receipts",
				count: 12,
			}),
		);
		expect(
			await Bun.file(`${dir}/plans/filter-apply-plan.json`).text(),
		).not.toContain("jane@example.com");

		const confirmed = await runCli([
			"filters",
			"apply",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(confirmed.code, confirmed.stderr).toBe(0);
		const confirmedOutput = JSON.parse(confirmed.stdout);
		expect(confirmedOutput).toMatchObject({
			kind: "workspace-filter-apply-summary",
			dryRun: false,
			mutated: true,
			create: 2,
			existing: 1,
			blocked: 2,
		});
		expect(existsSync(confirmedOutput.auditPath)).toBe(true);
		const dataset = await Bun.file(dataPath).json();
		const created = dataset.filters.filter(
			(filter: { name: string }) =>
				filter.name.includes("stripe.com") ||
				filter.name.includes("spam.example.com"),
		);
		expect(created).toHaveLength(2);
		const stripe = created.find((filter: { name: string }) =>
			filter.name.includes("stripe.com"),
		);
		expect(stripe.name).toBe("Receipts - stripe.com");
		expect(stripe.conditions[0]).toContain(
			'address :domain :is "From" "stripe.com"',
		);
		expect(stripe.conditions[0]).toContain('fileinto "Receipts"');
		expect(stripe.conditions[0]).toContain('addflag "\\\\Seen"');
	});

	test("filters load infers naming conventions and consolidate merges generated filters into existing names", async () => {
		const dir = tmpPath("filter-consolidation-workspace");
		const dataPath = tmpPath("filter-consolidation-dataset.json");
		await writeDataset(dataPath, {
			folders: [
				{
					id: "receipts",
					name: "Receipts",
					type: "folder",
					total: 0,
					unread: 0,
				},
				{
					id: "credit-card",
					name: "credit-card",
					type: "folder",
					total: 0,
					unread: 0,
				},
			],
			filters: [
				{
					id: "manual-receipts",
					name: "Fin - Purchases",
					enabled: true,
					conditions: ['require ["fileinto"]; fileinto "Receipts";'],
					actions: ['require ["fileinto"]; fileinto "Receipts";'],
				},
				{
					id: "generated-stripe",
					name: "Email Organizer: stripe.com -> Receipts",
					enabled: true,
					conditions: [
						'if address :domain :is "From" "stripe.com" { fileinto "Receipts"; stop; }',
					],
					actions: [
						'if address :domain :is "From" "stripe.com" { fileinto "Receipts"; stop; }',
					],
				},
				{
					id: "generated-shop",
					name: "Email Organizer: shop.example.com -> Receipts",
					enabled: true,
					conditions: [
						'if address :domain :is "From" "shop.example.com" { fileinto "Receipts"; stop; }',
					],
					actions: [
						'if address :domain :is "From" "shop.example.com" { fileinto "Receipts"; stop; }',
					],
				},
			],
			messages: [],
		});

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(await runCli(["load", "filters", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		const loadedFilters = await Bun.file(`${dir}/filters.json`).json();
		expect(loadedFilters.namingConventions).toContainEqual(
			expect.objectContaining({
				targetFolder: "Receipts",
				prefix: "Fin - Purchases",
				scope: "generic",
			}),
		);

		const dryRun = await runCli([
			"filters",
			"consolidate",
			"--dir",
			dir,
			"--data-path",
			dataPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		const dryRunOutput = JSON.parse(dryRun.stdout);
		expect(dryRunOutput).toMatchObject({
			kind: "workspace-filter-consolidation",
			dryRun: true,
			mutated: false,
			candidates: 1,
			consolidatableGeneratedFilters: 2,
		});
		expect(dryRunOutput.consolidationCandidates[0]).toMatchObject({
			existingFilter: { name: "Fin - Purchases", targetFolder: "Receipts" },
			generatedFilters: [
				{ domain: "shop.example.com" },
				{ domain: "stripe.com" },
			],
		});

		const confirmed = await runCli([
			"filters",
			"consolidate",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(confirmed.code, confirmed.stderr).toBe(0);
		const confirmedOutput = JSON.parse(confirmed.stdout);
		expect(confirmedOutput).toMatchObject({
			mutated: true,
			candidates: 1,
			consolidatableGeneratedFilters: 2,
		});
		expect(existsSync(confirmedOutput.auditPath)).toBe(true);
		const dataset = await Bun.file(dataPath).json();
		expect(
			dataset.filters.map((filter: { name: string }) => filter.name),
		).toEqual(["Fin - Purchases"]);
		expect(dataset.filters[0].conditions[0]).toContain(
			"email-organizer consolidated domains",
		);
		expect(dataset.filters[0].conditions[0]).toContain("shop.example.com");
		expect(dataset.filters[0].conditions[0]).toContain("stripe.com");
	});

	test("filters group promotes remaining generated filters into generic grouped filters", async () => {
		const dir = tmpPath("filter-group-workspace");
		const dataPath = tmpPath("filter-group-dataset.json");
		await writeDataset(dataPath, {
			folders: [
				{ id: "invoice", name: "invoice", type: "folder", total: 0, unread: 0 },
				{ id: "spam", name: "Spam", type: "system", total: 0, unread: 0 },
				{ id: "hunt", name: "hunt", type: "folder", total: 0, unread: 0 },
			],
			filters: [
				{
					id: "generated-invoice",
					name: "Email Organizer: billing.example.com -> invoice",
					enabled: true,
					conditions: [
						'if address :domain :is "From" "billing.example.com" { fileinto "invoice"; stop; }',
					],
					actions: [
						'if address :domain :is "From" "billing.example.com" { fileinto "invoice"; stop; }',
					],
				},
				{
					id: "generated-spam",
					name: "Email Organizer: promo.example.com -> Spam",
					enabled: true,
					conditions: [
						'if address :domain :is "From" "promo.example.com" { fileinto "Spam"; stop; }',
					],
					actions: [
						'if address :domain :is "From" "promo.example.com" { fileinto "Spam"; stop; }',
					],
				},
				{
					id: "generated-hunt",
					name: "Email Organizer: edc.example.com -> hunt",
					enabled: true,
					conditions: [
						'if address :domain :is "From" "edc.example.com" { fileinto "hunt"; stop; }',
					],
					actions: [
						'if address :domain :is "From" "edc.example.com" { fileinto "hunt"; stop; }',
					],
				},
			],
			messages: [],
		});

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(await runCli(["load", "filters", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);

		const dryRun = await runCli([
			"filters",
			"group",
			"--dir",
			dir,
			"--dry-run",
			"--data-path",
			dataPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		const dryRunOutput = JSON.parse(dryRun.stdout);
		expect(dryRunOutput).toMatchObject({
			kind: "workspace-filter-group-summary",
			dryRun: true,
			mutated: false,
			groups: 3,
			create: 3,
			update: 0,
			delete: 3,
		});
		expect(dryRunOutput.filters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Fin - Invoices",
					targetFolder: "invoice",
					domains: ["billing.example.com"],
					deletes: 1,
				}),
				expect.objectContaining({
					name: "Spam - Marketing",
					targetFolder: "Spam",
					domains: ["promo.example.com"],
					deletes: 1,
				}),
				expect.objectContaining({
					name: "Hunt - EDC",
					targetFolder: "hunt",
					domains: ["edc.example.com"],
					deletes: 1,
				}),
			]),
		);

		const confirmed = await runCli([
			"filters",
			"group",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(confirmed.code, confirmed.stderr).toBe(0);
		const confirmedOutput = JSON.parse(confirmed.stdout);
		expect(confirmedOutput).toMatchObject({
			dryRun: false,
			mutated: true,
			groups: 3,
			create: 3,
			delete: 3,
		});
		expect(existsSync(confirmedOutput.auditPath)).toBe(true);
		const dataset = await Bun.file(dataPath).json();
		expect(
			dataset.filters.map((filter: { name: string }) => filter.name).sort(),
		).toEqual(["Fin - Invoices", "Hunt - EDC", "Spam - Marketing"]);
		expect(
			dataset.filters.find(
				(filter: { name: string }) => filter.name === "Fin - Invoices",
			).conditions[0],
		).toContain("billing.example.com");
		expect(
			dataset.filters.find(
				(filter: { name: string }) => filter.name === "Spam - Marketing",
			).conditions[0],
		).toContain("promo.example.com");
		expect(
			dataset.filters.find(
				(filter: { name: string }) => filter.name === "Hunt - EDC",
			).conditions[0],
		).toContain("edc.example.com");
	});

	test("filters apply blocks domain-only filters with cross-workspace target conflicts", async () => {
		const first = workspacePaths(tmpPath("filter-conflict-a"));
		const second = workspacePaths(tmpPath("filter-conflict-b"));
		const folders = [
			{ id: "receipts", name: "Receipts", type: "folder" as const },
			{ id: "spam", name: "Spam", type: "system" as const },
		];
		await writeFolders(first, folders);
		await writeFilters(first, [], 160);
		await writeFolders(second, folders);
		await Bun.$`mkdir -p ${first.plansDir} ${second.plansDir}`.quiet();
		await Bun.write(
			`${first.plansDir}/filter-recommendations.json`,
			`${JSON.stringify(
				{
					filterRecommendations: [
						{
							domain: "shared.example.com",
							targetFolder: "Receipts",
							count: 5,
							safeForDomainFilter: true,
						},
						{
							domain: "receipt.example.com",
							targetFolder: "Receipts",
							count: 4,
							safeForDomainFilter: true,
						},
					],
					archiveFollowups: [],
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			`${second.plansDir}/filter-recommendations.json`,
			`${JSON.stringify(
				{
					filterRecommendations: [
						{
							domain: "shared.example.com",
							targetFolder: "Spam",
							count: 3,
							safeForDomainFilter: true,
						},
					],
					archiveFollowups: [],
				},
				null,
				2,
			)}\n`,
		);

		const dryRun = await runCli([
			"filters",
			"apply",
			"--dirs",
			`${first.dir},${second.dir}`,
			"--dry-run",
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);
		const output = JSON.parse(dryRun.stdout);
		expect(output).toMatchObject({
			kind: "workspace-filter-apply-summary",
			dryRun: true,
			eligible: 1,
			create: 1,
			blocked: 2,
		});
		expect(output.filters).toEqual([
			expect.objectContaining({
				domain: "receipt.example.com",
				targetFolder: "Receipts",
			}),
		]);
		expect(output.blockedRecommendations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					domain: "shared.example.com",
					targetFolder: "Receipts",
				}),
				expect.objectContaining({
					domain: "shared.example.com",
					targetFolder: "Spam",
				}),
			]),
		);
	});

	test("confirmed apply refuses when no dry-run report exists", async () => {
		const dir = tmpPath("no-dry-run-workspace");
		const dataPath = tmpPath("proton-dataset.json");
		await copyFixtureDataset(dataPath);

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"inbox",
					"--limit",
					"1",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);

		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		const messagePath = `${dir}/${status.items[0].file}`;
		const message = await Bun.file(messagePath).json();
		message.status = "classified";
		message.statusUpdatedAt = new Date().toISOString();
		message.decision = {
			action: "move",
			targetFolder: "Receipts",
			markRead: true,
			confidence: 0.9,
			reason: "Organized by existing receipt folder.",
		};
		await Bun.write(messagePath, `${JSON.stringify(message, null, 2)}\n`);

		const confirmedApply = await runCli([
			"apply",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(confirmedApply.code).toBe(1);
		expect(confirmedApply.stderr).toContain(
			"requires a successful apply --dry-run report",
		);
	});

	test("confirmed apply refuses when the plan changed after dry run", async () => {
		const dir = tmpPath("stale-dry-run-workspace");
		const dataPath = tmpPath("proton-dataset.json");
		await copyFixtureDataset(dataPath);

		expect(
			(await runCli(["load", "folders", "--dir", dir, "--data-path", dataPath]))
				.code,
		).toBe(0);
		expect(
			(
				await runCli([
					"batch",
					"--dir",
					dir,
					"--folder",
					"Inbox",
					"--limit",
					"1",
					"--data-path",
					dataPath,
				])
			).code,
		).toBe(0);

		const status = await Bun.file(`${dir}/messages/_status.json`).json();
		const messagePath = `${dir}/${status.items[0].file}`;
		const message = await Bun.file(messagePath).json();
		message.status = "classified";
		message.statusUpdatedAt = new Date().toISOString();
		message.decision = {
			action: "move",
			targetFolder: "Receipts",
			markRead: true,
			confidence: 0.9,
			reason: "Organized by existing receipt folder.",
		};
		await Bun.write(messagePath, `${JSON.stringify(message, null, 2)}\n`);

		const dryRun = await runCli([
			"apply",
			"--dir",
			dir,
			"--dry-run",
			"--data-path",
			dataPath,
		]);
		expect(dryRun.code, dryRun.stderr).toBe(0);

		message.decision.targetFolder = "Finance";
		await Bun.write(messagePath, `${JSON.stringify(message, null, 2)}\n`);

		const confirmedApply = await runCli([
			"apply",
			"--dir",
			dir,
			"--confirm",
			"--data-path",
			dataPath,
		]);
		expect(confirmedApply.code).toBe(1);
		expect(confirmedApply.stderr).toContain(
			"plan changed after the last dry run",
		);
	});

	test("confirmed apply unlabels the resolved source folder when refiling already organized mail", async () => {
		const paths = workspacePaths(tmpPath("source-unlabel-workspace"));
		await writeFolders(paths, [
			{ id: "0", name: "Inbox", type: "system" },
			{ id: "6", name: "Archive", type: "system" },
			{ id: "bank-id", name: "bank", type: "label" },
		]);
		const item: MessageWorkItem = {
			kind: "message-work-item",
			id: "m_hash_source_unlabel",
			sourceMessageId: "source-unlabel-message",
			sourceIdHash: "source_hash_source_unlabel",
			file: "messages/m_hash_source_unlabel.json",
			status: "classified",
			statusUpdatedAt: new Date().toISOString(),
			currentFolder: "Archive",
			packet: {
				kind: "message",
				id: "m_hash_source_unlabel",
				sourceIdHash: "source_hash_source_unlabel",
				fromDomain: "example.com",
				subject: "Statement",
				snippet: "Statement ready.",
				currentFolder: "Archive",
				folders: ["Inbox", "Archive", "bank"],
			},
			decision: {
				action: "move",
				targetFolder: "bank",
				markRead: true,
				reason: "Move from Archive to bank.",
			},
		};
		await writeMessageWorkItems(paths, [item]);
		await dryRunWorkspaceApply(paths);

		const unlabels: { messageIds: string[]; labelId: string }[] = [];
		const client: MailProviderClient = {
			provider: "protonmail",
			async listFolders() {
				return [];
			},
			async createFolder() {
				throw new Error("not used");
			},
			async listFilters() {
				return [];
			},
			async createFilter() {
				throw new Error("not used");
			},
			async updateFilter() {
				throw new Error("not used");
			},
			async deleteFilter() {
				throw new Error("not used");
			},
			async listMessages() {
				return [];
			},
			async moveMessages() {},
			async unlabelMessages(input) {
				unlabels.push(input);
			},
			async markMessagesRead() {},
		};

		await applyWorkspaceMutations(paths, client);
		expect(unlabels).toEqual([
			{ messageIds: ["source-unlabel-message"], labelId: "6" },
		]);
	});
});
