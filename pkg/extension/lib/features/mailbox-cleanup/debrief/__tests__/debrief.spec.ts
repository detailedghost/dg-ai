import { describe, expect, it } from "bun:test";
import { createMailboxDebriefService } from "../index";

const PLAN_ALIAS = "plan_0123456789abcdef0123456789abcdef";
const REVISION_ALIAS = "rev_fedcba9876543210fedcba9876543210";
const RAW_SENTINEL = "Ada Lovelace <ada@example.test> selector=#private-row";

type Download = Readonly<{
	filename: string;
	mimeType: string;
	content: string;
}>;

type DebriefResult = Readonly<{
	status: "downloaded" | "download_pending" | "download_failed";
	filename: string;
	content: string;
	downloadId?: number;
}>;

type DebriefService = Readonly<{
	generate(input: unknown): Promise<DebriefResult>;
	regenerate(input: Readonly<{
		planAlias: string;
		revisionAlias: string;
	}>): Promise<DebriefResult>;
}>;

type DebriefStorage = Readonly<{
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	remove(key: string): Promise<void>;
}>;

type MutableTerminalInput = {
	planAlias: string;
	results: Array<Record<string, unknown>>;
} & Record<string, unknown>;

const createService = createMailboxDebriefService as unknown as (
	deps: Readonly<{
		now(): string;
		download(value: Download): Promise<number>;
		downloadState(
			downloadId: number,
		): Promise<"in_progress" | "complete" | "interrupted" | "missing">;
		storage: DebriefStorage;
	}>,
) => DebriefService;

function makeDebrief(deps: Readonly<{
	now(): string;
	download(value: Download): Promise<void | number>;
	downloadState?(
		downloadId: number,
	): Promise<"in_progress" | "complete" | "interrupted" | "missing">;
	storage: DebriefStorage;
}>): DebriefService {
	let nextDownloadId = 0;
	return createService({
		...deps,
		async download(value) {
			const result = await deps.download(value);
			return typeof result === "number" ? result : ++nextDownloadId;
		},
		downloadState:
			deps.downloadState ?? (async () => "complete" as const),
	});
}

function memoryStorage(): DebriefStorage &
	Readonly<{ values: Map<string, unknown> }> {
	const values = new Map<string, unknown>();
	return {
		values,
		async get(key) {
			const value = values.get(key);
			return value === undefined ? undefined : structuredClone(value);
		},
		async set(key, value) {
			values.set(key, structuredClone(value));
		},
		async remove(key) {
			values.delete(key);
		},
	};
}

function terminalInput(overrides: Record<string, unknown> = {}) {
	return Object.freeze({
		schemaVersion: 1,
		planAlias: PLAN_ALIAS,
		revisionAlias: REVISION_ALIAS,
		terminalStatus: "completed",
		results: [
			{
				schemaVersion: 1,
				index: 0,
				action: {
					schemaVersion: 1,
					actionAlias: "act_89abcdef0123456789abcdef01234567",
					type: "archive",
					messageAlias: "msg_00112233445566778899aabbccddeeff",
				},
				status: "completed",
				affectedCount: 1,
			},
			{
				schemaVersion: 1,
				index: 1,
				action: {
					schemaVersion: 1,
					actionAlias: "act_abcdef0123456789abcdef0123456789",
					type: "deactivate_filter",
					filterAlias: "flt_2468ace013579bdf2468ace013579bdf",
				},
				status: "needs_review",
				reasonCode: "verification_mismatch",
				affectedCount: 0,
			},
			{
				schemaVersion: 1,
				index: 2,
				action: {
					schemaVersion: 1,
					actionAlias: "act_13579bdf02468ace13579bdf02468ace",
					type: "create_folder",
					folderAlias: "fld_ffeeddccbbaa99887766554433221100",
				},
				status: "skipped",
				reasonCode: "canceled",
				affectedCount: 0,
			},
			{
				schemaVersion: 1,
				index: 3,
				action: {
					schemaVersion: 1,
					actionAlias: "act_2468ace013579bdf2468ace013579bdf",
					type: "create_label",
					labelAlias: "lbl_13579bdf02468ace13579bdf02468ace",
				},
				status: "failed",
				reasonCode: "provider_refused",
				affectedCount: 0,
			},
			{
				schemaVersion: 1,
				index: 4,
				action: {
					schemaVersion: 1,
					actionAlias: "act_369cf01258adeb47369cf01258adeb47",
					type: "create_filter",
					filterAlias: "flt_02468ace13579bdf02468ace13579bdf",
				},
				status: "completed",
				affectedCount: 1,
			},
			{
				schemaVersion: 1,
				index: 5,
				action: {
					schemaVersion: 1,
					actionAlias: "act_47ad0369cf258be147ad0369cf258be1",
					type: "change_filter",
					filterAlias: "flt_2468ace013579bdf2468ace013579bdf",
					replacementFilterAlias:
						"flt_89abcdef0123456789abcdef01234567",
				},
				status: "completed",
				affectedCount: 1,
			},
		],
		finalInboxObservation: {
			status: "observed",
			count: 0,
			observedAt: "2026-07-27T12:59:59.000Z",
		},
		...overrides,
	});
}

describe("mailbox terminal debrief", () => {
	it("downloads one sanitized canonical document with the fixed filename, schema, section order, statuses, and reason codes", async () => {
		const downloads: Download[] = [];
		const service = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage: memoryStorage(),
			async download(value) {
				downloads.push(structuredClone(value));
			},
		});

		const result = await service.generate(terminalInput());
		expect(result.status).toBe("downloaded");
		expect(result.filename).toBe(
			`mailbox-cleanup-debrief-v1-${PLAN_ALIAS}-${REVISION_ALIAS}.txt`,
		);
		expect(downloads).toEqual([
			{
				filename: result.filename,
				mimeType: "text/plain;charset=utf-8",
				content: result.content,
			},
		]);
		const headings = [
			"Mailbox Cleanup Debrief",
			"Plan",
			"Revision",
			"Terminal status",
			"Summary",
			"Actions",
			"Folders",
			"Labels and categories",
			"Filters Added",
			"Filters Changed",
			"Filters Deactivated",
			"Inbox",
			"Scope note",
			"Retention notice",
		];
		let previous = -1;
		for (const heading of headings) {
			const index = result.content.indexOf(heading);
			expect(index).toBeGreaterThan(previous);
			previous = index;
		}
		expect(result.content).toContain("completed");
		expect(result.content).toContain("skipped");
		expect(result.content).toContain("needs_review");
		expect(result.content).toContain("failed");
		expect(result.content).toContain("verification_mismatch");
		expect(result.content).toContain("provider_refused");
		expect(result.content).toContain("create_filter");
		expect(result.content).toContain("change_filter");
		expect(result.content).toContain("deactivate_filter");
		expect(result.content).toContain(
			"Filters are deactivated, not deleted",
		);
		expect(result.content).toContain(
			"outside extension TTL cleanup",
		);
		expect(result.content).not.toContain(RAW_SENTINEL);
		expect(result.content.endsWith("\n")).toBe(true);
	});

	it("renders completed, canceled, and failed terminal statuses without changing canonical section order", async () => {
		for (const terminalStatus of ["completed", "canceled", "failed"]) {
			const service = makeDebrief({
				now: () => "2026-07-27T13:00:00.000Z",
				storage: memoryStorage(),
				async download() {},
			});
			const result = await service.generate(
				terminalInput({ terminalStatus }),
			);
			expect(result.content).toContain(
				`Terminal status: ${terminalStatus}`,
			);
			expect(result.content.indexOf("Filters Added")).toBeLessThan(
				result.content.indexOf("Filters Changed"),
			);
			expect(result.content.indexOf("Filters Changed")).toBeLessThan(
				result.content.indexOf("Filters Deactivated"),
			);
		}
	});

	it("canonicalizes action sections by action index even when terminal results arrive out of order", async () => {
		const service = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage: memoryStorage(),
			async download() {},
		});
		const input = structuredClone(
			terminalInput(),
		) as unknown as MutableTerminalInput;
		input.results.reverse();
		const result = await service.generate(input);
		const first = "act_89abcdef0123456789abcdef01234567";
		const second = "act_abcdef0123456789abcdef0123456789";
		expect(result.content.indexOf(first)).toBeLessThan(
			result.content.indexOf(second),
		);
	});

	it("rejects low-entropy aliases, unknown result statuses, and unknown reason codes from the fixed schema", async () => {
		const lowEntropyAlias = structuredClone(
			terminalInput(),
		) as unknown as MutableTerminalInput;
		lowEntropyAlias.planAlias = "plan_11111111111111111111111111111111";
		const unknownStatus = structuredClone(
			terminalInput(),
		) as unknown as MutableTerminalInput;
		unknownStatus.results[0]!.status = "green";
		const unknownReason = structuredClone(
			terminalInput(),
		) as unknown as MutableTerminalInput;
		unknownReason.results[0]!.reasonCode = "made_up";
		const rejected = await Promise.all(
			[lowEntropyAlias, unknownStatus, unknownReason].map(async (input) => {
				const service = makeDebrief({
					now: () => "2026-07-27T13:00:00.000Z",
					storage: memoryStorage(),
					async download() {},
				});
				return service.generate(input).then(
					() => false,
					() => true,
				);
			}),
		);
		expect(rejected).toEqual([true, true, true]);
	});

	it("rejects raw provider text and unknown debrief fields before persistence or download", async () => {
		const downloads: Download[] = [];
		const service = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage: memoryStorage(),
			async download(value) {
				downloads.push(value);
			},
		});
		const thrown = await service
			.generate(terminalInput({ providerError: RAW_SENTINEL }))
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(thrown).toBeInstanceOf(Error);
		expect(String(thrown)).not.toContain(RAW_SENTINEL);
		expect(downloads).toEqual([]);
	});

	it("regenerates terminal output byte-for-byte and recovers from a failed download", async () => {
		let fail = true;
		const downloads: Download[] = [];
		const storage = memoryStorage();
		const service = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage,
			async download(value) {
				if (fail) {
					fail = false;
					throw new Error(RAW_SENTINEL);
				}
				downloads.push(structuredClone(value));
			},
		});

		const failed = await service.generate(terminalInput());
		expect(failed).toMatchObject({
			status: "download_failed",
		});
		expect(JSON.stringify(failed)).not.toContain(RAW_SENTINEL);

		const restarted = makeDebrief({
			now: () => "2026-07-28T13:00:00.000Z",
			storage,
			async download(value) {
				downloads.push(structuredClone(value));
			},
		});
		const recovered = await restarted.regenerate({
			planAlias: PLAN_ALIAS,
			revisionAlias: REVISION_ALIAS,
		});
		expect(recovered).toMatchObject({
			status: "downloaded",
			filename: failed.filename,
			content: failed.content,
		});
		expect(downloads).toHaveLength(1);
	});

	it("keeps delivery pending until the matching download completes and retries interrupted bytes after restart", async () => {
		const storage = memoryStorage();
		const downloads: Download[] = [];
		const queried: number[] = [];
		const first = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage,
			async download(value) {
				downloads.push(structuredClone(value));
				return 41;
			},
			async downloadState(downloadId) {
				queried.push(downloadId);
				return "in_progress";
			},
		});

		const pending = await first.generate(terminalInput());
		expect(pending).toMatchObject({
			status: "download_pending",
			downloadId: 41,
		});

		const restarted = makeDebrief({
			now: () => "2026-07-28T13:00:00.000Z",
			storage,
			async download(value) {
				downloads.push(structuredClone(value));
				return 42;
			},
			async downloadState(downloadId) {
				queried.push(downloadId);
				return downloadId === 41 ? "interrupted" : "complete";
			},
		});
		const retried = await restarted.regenerate({
			planAlias: PLAN_ALIAS,
			revisionAlias: REVISION_ALIAS,
		});
		expect(retried).toMatchObject({
			status: "download_pending",
			downloadId: 42,
			filename: pending.filename,
			content: pending.content,
		});
		const recovered = await restarted.regenerate({
			planAlias: PLAN_ALIAS,
			revisionAlias: REVISION_ALIAS,
		});

		expect(recovered).toMatchObject({
			status: "downloaded",
			downloadId: 42,
			filename: pending.filename,
			content: pending.content,
		});
		expect(downloads).toHaveLength(2);
		expect(downloads[1]).toEqual(downloads[0]);
		expect(queried).toEqual([41, 41, 42]);
	});

	it("does not cache or download a report until its durable write succeeds", async () => {
		const stored = memoryStorage();
		let writes = 0;
		let rejectWrite = true;
		const storage: DebriefStorage = {
			...stored,
			async set(key, value) {
				writes += 1;
				if (rejectWrite) {
					rejectWrite = false;
					throw new Error(RAW_SENTINEL);
				}
				await stored.set(key, value);
			},
		};
		const downloads: Download[] = [];
		const service = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage,
			async download(value) {
				downloads.push(structuredClone(value));
			},
		});

		await expect(service.generate(terminalInput())).rejects.toThrow();
		expect(downloads).toEqual([]);
		expect(stored.values.size).toBe(0);

		await expect(service.generate(terminalInput())).resolves.toMatchObject({
			status: "downloaded",
		});
		expect(writes).toBe(4);
		expect(stored.values.size).toBe(1);
		expect(downloads).toHaveLength(1);
	});

	it("rejects tampered durable report content after a service restart", async () => {
		const storage = memoryStorage();
		const generated = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage,
			async download() {},
		});
		await generated.generate(terminalInput());
		expect(storage.values.size).toBe(1);
		for (const [key, value] of storage.values) {
			const report = structuredClone(value) as Record<string, unknown>;
			storage.values.set(key, {
				...report,
				content: `${String(report.content)}\n${RAW_SENTINEL}`,
			});
		}

		const downloads: Download[] = [];
		const restarted = makeDebrief({
			now: () => "2026-07-28T13:00:00.000Z",
			storage,
			async download(value) {
				downloads.push(structuredClone(value));
			},
		});
		await expect(
			restarted.regenerate({
				planAlias: PLAN_ALIAS,
				revisionAlias: REVISION_ALIAS,
			}),
		).rejects.toThrow(/unavailable|invalid/i);
		expect(downloads).toEqual([]);
	});

	it("never says Inbox Zero without a fresh final UI observation of zero messages", async () => {
		for (const finalInboxObservation of [
			undefined,
			{ status: "cached", count: 0 },
			{ status: "ambiguous", count: 0 },
			{ status: "observed", count: 0 },
			{ status: "observed", count: 1 },
		]) {
			const service = makeDebrief({
				now: () => "2026-07-27T13:00:00.000Z",
				storage: memoryStorage(),
				async download() {},
			});
			const result = await service.generate(
				terminalInput({ finalInboxObservation }),
			);
			expect(result.content).not.toContain("Inbox Zero complete");
		}

		const service = makeDebrief({
			now: () => "2026-07-27T13:00:00.000Z",
			storage: memoryStorage(),
			async download() {},
		});
		const result = await service.generate(terminalInput());
		expect(result.content).toContain("Inbox Zero complete");
	});
});
