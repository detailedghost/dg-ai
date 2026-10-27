import { describe, expect, test } from "bun:test";
import {
	assertApprovedDeletes,
	buildSyncPlan,
	canonicalize,
	folderCreateOrder,
	folderDeleteOrder,
	orderedFilters,
	planHash,
	type DesiredFilter,
	type DesiredFolder,
	type LiveFilter,
	type LiveFolder,
	type SyncPlanInput,
} from "../plan";

const naming = {
	folderSlugPattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
	folderExceptions: ["Notification", "Alerts"],
};

function sieve(folder: string, domain = "shop.example"): string {
	return `require ["fileinto"];\nif address :domain :is "From" "${domain}" {\n  fileinto "${folder}";\n}\n`;
}

function wanted(
	name: string,
	folder = "fin/banking",
	protonId?: string,
	enabled = true,
): DesiredFilter {
	return {
		name,
		enabled,
		sieve: sieve(folder),
		...(protonId ? { protonId } : {}),
	};
}

function proton(
	id: string,
	name: string,
	folder = "fin/banking",
	patch: Partial<LiveFilter> = {},
): LiveFilter {
	return { id, name, enabled: true, sieve: sieve(folder), ...patch };
}

function folder(
	id: string,
	path: string,
	type: LiveFolder["type"] = "folder",
): LiveFolder {
	return { id, path, name: path.split("/").at(-1) ?? path, type };
}

function input(patch: Partial<SyncPlanInput> = {}): SyncPlanInput {
	return {
		desiredFilters: [],
		desiredFolders: [],
		liveFilters: [],
		liveFolders: [],
		naming,
		...patch,
	};
}

describe("filter policy plan", () => {
	test("creates a filter that exists only in the file", () => {
		const plan = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking")],
				liveFilters: [],
			}),
		);
		expect(plan.actions).toContainEqual({
			op: "create-filter",
			ref: "new:0",
			name: "Fin - Banking",
			enabled: true,
			sieve: sieve("fin/banking"),
		});
	});

	test("updates sieve, name, and enabled as separate change lists", () => {
		const sieveOnly = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/receipts", "f1")],
				liveFilters: [proton("f1", "Fin - Banking", "fin/banking")],
			}),
		);
		expect(sieveOnly.actions[0]).toMatchObject({
			op: "update-filter",
			changes: ["sieve"],
		});
		const renamed = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Receipts", "fin/banking", "f1")],
				liveFilters: [proton("f1", "Fin - Banking")],
			}),
		);
		expect(renamed.actions[0]).toMatchObject({
			op: "update-filter",
			fromName: "Fin - Banking",
			name: "Fin - Receipts",
			changes: ["name"],
		});
		const disabled = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1", false)],
				liveFilters: [proton("f1", "Fin - Banking")],
			}),
		);
		expect(disabled.actions[0]).toMatchObject({ changes: ["enabled"] });
	});

	test("treats equivalent newlines as the same sieve and skips a reorder", () => {
		const plan = buildSyncPlan(
			input({
				desiredFilters: [
					{
						...wanted("Fin - Banking", "fin/banking", "f1"),
						sieve: sieve("fin/banking").replaceAll("\n", "\r\n"),
					},
				],
				liveFilters: [proton("f1", "Fin - Banking")],
			}),
		);
		expect(plan.actions).toEqual([]);
	});

	test("reorders when file order differs and sorts a complete sequence first", () => {
		const second = proton("b", "Shop - Orders", "shop/orders");
		const first = proton("a", "Fin - Banking");
		const moved = buildSyncPlan(
			input({
				desiredFilters: [
					wanted("Shop - Orders", "shop/orders", "b"),
					wanted("Fin - Banking", "fin/banking", "a"),
				],
				liveFilters: [first, second],
			}),
		);
		expect(moved.actions).toContainEqual({
			op: "reorder-filters",
			names: ["Shop - Orders", "Fin - Banking"],
			ids: ["b", "a"],
		});
		expect(
			orderedFilters([
				{ ...second, sequence: 2 },
				{ ...first, sequence: 1 },
			]).map((filter) => filter.id),
		).toEqual(["a", "b"]);
		expect(
			orderedFilters([
				{ ...second, sequence: 2 },
				first,
			]).map((filter) => filter.id),
		).toEqual(["b", "a"]);
		expect(orderedFilters([])).toEqual([]);
	});

	test("shows Proton edits as drift and resolves pull or revert", () => {
		const base = proton("f1", "Fin - Banking");
		const drifted = proton("f1", "Fin - Banking", "fin/banking", {
			sieve: sieve("spam"),
		});
		const open = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [drifted],
				observedFilters: [base],
			}),
		);
		expect(open.notices).toContainEqual(
			expect.objectContaining({ op: "drift", id: "f1" }),
		);
		expect(open.actions).toEqual([]);
		const pulled = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [drifted],
				observedFilters: [base],
				pull: ["f1"],
			}),
		);
		expect(pulled.actions.map((action) => action.op)).toContain("pull-filter");
		expect(pulled.notices.some((notice) => notice.op === "drift")).toBe(false);
		const reverted = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [drifted],
				observedFilters: [base],
				revert: ["Fin - Banking"],
			}),
		);
		expect(reverted.actions).toContainEqual(
			expect.objectContaining({ op: "revert-filter", name: "Fin - Banking" }),
		);
		expect(planHash(open)).not.toBe(planHash(pulled));
		expect(() =>
			buildSyncPlan(
				input({
					desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
					liveFilters: [drifted],
					observedFilters: [base],
					pull: ["f1"],
					revert: ["f1"],
				}),
			),
		).toThrow("Choose pull or revert for Fin - Banking, not both");
		expect(() =>
			buildSyncPlan(
				input({
					desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
					liveFilters: [drifted],
					observedFilters: [base],
					pull: ["missing"],
				}),
			),
		).toThrow("Unknown pull target: missing");
	});

	test("treats a two-sided change as drift and a file-only change as an update", () => {
		const observed = proton("f1", "Fin - Banking");
		const conflict = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Receipts", "fin/banking", "f1")],
				liveFilters: [proton("f1", "Fin - Banking", "fin/banking", { enabled: false })],
				observedFilters: [observed],
			}),
		);
		expect(conflict.notices[0]).toMatchObject({
			op: "drift",
			detail: "Both the declared file and Proton changed this filter",
		});
		const pushed = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Receipts", "fin/banking", "f1")],
				liveFilters: [observed],
				observedFilters: [observed],
			}),
		);
		expect(pushed.actions[0]).toMatchObject({
			op: "update-filter",
			changes: ["name"],
		});
	});

	test("gates deletes and pulls filters that were added in Proton", () => {
		const extra = proton("new", "Shop - Orders", "shop/orders");
		const kept = proton("f1", "Fin - Banking");
		const added = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [kept, extra],
				observedFilters: [kept],
			}),
		);
		expect(added.notices).toContainEqual(
			expect.objectContaining({
				op: "drift",
				id: "new",
				detail: "Filter is in Proton and not in the declared file",
			}),
		);
		const removed = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [kept, extra],
				observedFilters: [kept, extra],
			}),
		);
		expect(removed.notices).toContainEqual(
			expect.objectContaining({ op: "delete-withheld", id: "new" }),
		);
		expect(removed.actions.some((action) => action.op === "delete-filter")).toBe(
			false,
		);
		const approved = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [kept, extra],
				observedFilters: [kept, extra],
				approveDelete: ["Shop - Orders"],
			}),
		);
		expect(approved.actions).toContainEqual({
			op: "delete-filter",
			id: "new",
			name: "Shop - Orders",
		});
		const pulled = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [kept, extra],
				observedFilters: [kept],
				pull: ["new"],
			}),
		);
		expect(pulled.actions).toContainEqual(
			expect.objectContaining({ op: "pull-filter", id: "new" }),
		);
		const reverted = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [kept, extra],
				observedFilters: [kept],
				revert: ["new"],
				approveDelete: ["new"],
			}),
		);
		expect(reverted.actions).toContainEqual({
			op: "delete-filter",
			id: "new",
			name: "Shop - Orders",
		});
		expect(
			buildSyncPlan(
				input({
					desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
					liveFilters: [kept, extra],
					observedFilters: [kept],
					revert: ["new"],
				}),
			).notices.some((notice) => notice.op === "drift"),
		).toBe(true);
		expect(() =>
			buildSyncPlan(
				input({
					desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
					liveFilters: [kept],
					observedFilters: [kept],
					approveDelete: ["nope"],
				}),
			),
		).toThrow("Unknown approve-delete target: nope");
	});

	test("does not match an ambiguous name and prefers a proton id", () => {
		const ambiguous = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking")],
				liveFilters: [
					proton("a", "Fin - Banking"),
					proton("b", "Fin - Banking", "shop/orders"),
				],
			}),
		);
		expect(ambiguous.actions.some((action) => action.op === "create-filter")).toBe(
			true,
		);
		expect(ambiguous.notices.filter((notice) => notice.op === "drift")).toHaveLength(
			2,
		);
		const byId = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Receipts", "fin/banking", "b")],
				liveFilters: [
					proton("a", "Fin - Banking"),
					proton("b", "Fin - Banking"),
				],
			}),
		);
		expect(byId.actions[0]).toMatchObject({
			op: "update-filter",
			id: "b",
			changes: ["name"],
		});
	});

	test("manages folder creates, renames, drift, and refuses system deletes", () => {
		const created = buildSyncPlan(
			input({
				desiredFolders: [{ path: "fin/banking", type: "folder" }],
				liveFolders: [folder("inbox", "Inbox", "system")],
			}),
		);
		expect(created.actions).toContainEqual({
			op: "create-folder",
			path: "fin/banking",
			type: "folder",
		});
		expect(created.actions.some((action) => action.op === "delete-folder")).toBe(
			false,
		);
		const renamed = buildSyncPlan(
			input({
				desiredFolders: [
					{ path: "fin/receipts", type: "folder", protonId: "fin" },
				],
				liveFolders: [folder("fin", "fin/banking")],
			}),
		);
		expect(renamed.actions).toContainEqual({
			op: "rename-folder",
			id: "fin",
			from: "fin/banking",
			to: "fin/receipts",
		});
		const drifted = buildSyncPlan(
			input({
				desiredFolders: [
					{ path: "fin/banking/", type: "folder", protonId: "fin" },
				],
				liveFolders: [folder("fin", "fin/receipts")],
				observedFolders: [folder("fin", "fin/banking")],
			}),
		);
		expect(drifted.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "folder", id: "fin" }),
		);
		const dropped = buildSyncPlan(
			input({
				desiredFolders: [],
				liveFolders: [folder("fin", "fin/banking"), folder("box", "Inbox", "system")],
				observedFolders: [folder("fin", "fin/banking")],
			}),
		);
		expect(dropped.notices).toContainEqual(
			expect.objectContaining({ op: "delete-withheld", id: "fin" }),
		);
		expect(
			dropped.notices.some(
				(notice) => notice.op !== "rename-proposal" && notice.name === "Inbox",
			),
		).toBe(false);
	});

	test("proposes renames and does not apply them", () => {
		const plan = buildSyncPlan(
			input({
				desiredFilters: [
					{
						name: "Bot - Archive",
						enabled: true,
						sieve: sieve("archive"),
						protonId: "bot",
					},
				],
				desiredFolders: [
					{ path: "Fin/Banking", type: "folder" },
					{ path: "Notification/Alerts", type: "folder" },
				],
				liveFilters: [proton("bot", "Bot - Archive", "archive")],
				liveFolders: [
					folder("cap", "Fin/Banking"),
					folder("note", "Notification/Alerts"),
				],
			}),
		);
		expect(plan.actions.some((action) => action.op === "update-filter")).toBe(
			false,
		);
		expect(plan.notices).toContainEqual(
			expect.objectContaining({
				op: "rename-proposal",
				target: "filter",
				from: "Bot - Archive",
				to: "+Archive",
			}),
		);
		expect(plan.notices).toContainEqual(
			expect.objectContaining({
				op: "rename-proposal",
				target: "folder",
				from: "Fin/Banking",
				to: "fin/banking",
			}),
		);
		expect(
			plan.notices.some(
				(notice) =>
					notice.op === "rename-proposal" && notice.from === "Notification/Alerts",
			),
		).toBe(false);
	});

	test("hashes a canonical plan and orders folder creates before children", () => {
		const plan = buildSyncPlan(input());
		expect(planHash(plan)).toHaveLength(64);
		expect(canonicalize({ b: 1, a: undefined, c: { d: 2 } })).toEqual({
			b: 1,
			c: { d: 2 },
		});
		expect(
			folderCreateOrder([
				{ path: "fin/banking" },
				{ path: "fin" },
				{ path: "shop" },
			]).map((folder) => folder.path),
		).toEqual(["fin", "shop", "fin/banking"]);
		expect(
			folderDeleteOrder([{ path: "fin" }, { path: "fin/banking" }]).map(
				(folder) => folder.path,
			),
		).toEqual(["fin/banking", "fin"]);
		expect(() =>
			assertApprovedDeletes(
				[{ op: "delete-filter", id: "f1", name: "Old" }],
				[],
			),
		).toThrow("Refusing to delete Old without per-item approval");
		expect(() =>
			assertApprovedDeletes(
				[{ op: "delete-folder", id: "d1", path: "fin/old" }],
				["d1"],
			),
		).not.toThrow();
		expect(canonicalize([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
	});

	test("treats a file-only folder rename as a push and resolves folder drift", () => {
		const pushed = buildSyncPlan(
			input({
				desiredFolders: [
					{ path: "fin/receipts", type: "folder", protonId: "fin" },
				],
				liveFolders: [folder("fin", "fin/banking")],
				observedFolders: [folder("fin", "fin/banking")],
			}),
		);
		expect(pushed.actions).toContainEqual({
			op: "rename-folder",
			id: "fin",
			from: "fin/banking",
			to: "fin/receipts",
		});
		const both = buildSyncPlan(
			input({
				desiredFolders: [
					{ path: "fin/receipts", type: "folder", protonId: "fin" },
				],
				liveFolders: [folder("fin", "shop/orders")],
				observedFolders: [folder("fin", "fin/banking")],
			}),
		);
		expect(both.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "folder", id: "fin" }),
		);
		const pulled = buildSyncPlan(
			input({
				desiredFolders: [
					{ path: "fin/banking/", type: "folder", protonId: "fin" },
				],
				liveFolders: [folder("fin", "//fin//receipts/")],
				observedFolders: [folder("fin", "fin/banking")],
				pull: ["fin/receipts"],
			}),
		);
		expect(pulled.actions).toContainEqual({
			op: "pull-folder",
			id: "fin",
			path: "fin/receipts",
			type: "folder",
		});
		expect(() =>
			buildSyncPlan(
				input({
					desiredFolders: [
						{ path: "fin/banking", type: "folder", protonId: "fin" },
					],
					liveFolders: [folder("fin", "fin/receipts")],
					observedFolders: [folder("fin", "fin/banking")],
					pull: ["fin"],
					revert: ["fin"],
				}),
			),
		).toThrow("Choose pull or revert for fin/receipts, not both");
		const restored = buildSyncPlan(
			input({
				desiredFolders: [
					{ path: "fin/banking", type: "folder", protonId: "fin" },
				],
				liveFolders: [folder("fin", "fin/receipts")],
				observedFolders: [folder("fin", "fin/banking")],
				revert: ["fin"],
			}),
		);
		expect(restored.actions).toContainEqual({
			op: "rename-folder",
			id: "fin",
			from: "fin/receipts",
			to: "fin/banking",
		});
	});

	test("pulls or deletes folders that exist only in Proton", () => {
		const extra = folder("new", "shop/orders");
		const kept = folder("fin", "fin/banking");
		const open = buildSyncPlan(
			input({
				desiredFolders: [{ path: "fin/banking", type: "folder", protonId: "fin" }],
				liveFolders: [kept, extra],
				observedFolders: [kept],
			}),
		);
		expect(open.notices).toContainEqual(
			expect.objectContaining({
				op: "drift",
				target: "folder",
				id: "new",
			}),
		);
		const pulled = buildSyncPlan(
			input({
				desiredFolders: [{ path: "fin/banking", type: "folder", protonId: "fin" }],
				liveFolders: [kept, extra],
				observedFolders: [kept],
				pull: ["shop/orders"],
			}),
		);
		expect(pulled.actions).toContainEqual(
			expect.objectContaining({ op: "pull-folder", path: "shop/orders" }),
		);
		expect(() =>
			buildSyncPlan(
				input({
					desiredFolders: [
						{ path: "fin/banking", type: "folder", protonId: "fin" },
					],
					liveFolders: [kept, extra],
					observedFolders: [kept],
					pull: ["new"],
					revert: ["new"],
				}),
			),
		).toThrow("Choose pull or revert for shop/orders, not both");
		const removed = buildSyncPlan(
			input({
				desiredFolders: [{ path: "fin/banking", type: "folder", protonId: "fin" }],
				liveFolders: [kept, extra],
				observedFolders: [kept],
				revert: ["new"],
				approveDelete: ["shop/orders"],
			}),
		);
		expect(removed.actions).toContainEqual({
			op: "delete-folder",
			id: "new",
			path: "shop/orders",
		});
		const approved = buildSyncPlan(
			input({
				desiredFolders: [],
				liveFolders: [extra],
				observedFolders: [extra],
				approveDelete: ["shop/orders"],
			}),
		);
		expect(approved.actions).toContainEqual({
			op: "delete-folder",
			id: "new",
			path: "shop/orders",
		});
		expect(() =>
			buildSyncPlan(
				input({
					desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
					liveFilters: [proton("f1", "Fin - Banking")],
					observedFilters: [proton("f1", "Fin - Banking")],
					revert: ["missing"],
				}),
			),
		).toThrow("Unknown revert target: missing");
	});

	test("skips system folders, consumed ids, and duplicate paths", () => {
		const system = buildSyncPlan(
			input({
				desiredFolders: [{ path: "Inbox", type: "system" }],
				liveFolders: [],
			}),
		);
		expect(system.actions).toEqual([]);
		const same = buildSyncPlan(
			input({
				desiredFolders: [{ path: "fin/banking/", type: "folder", protonId: "fin" }],
				liveFolders: [folder("fin", "fin/banking")],
			}),
		);
		expect(same.actions).toEqual([]);
		const consumed = buildSyncPlan(
			input({
				desiredFilters: [
					wanted("Fin - Banking", "fin/banking", "a"),
					wanted("Shop - Orders", "shop/orders", "a"),
				],
				liveFilters: [
					proton("a", "Fin - Banking"),
					proton("b", "Shop - Orders", "shop/orders"),
				],
			}),
		);
		expect(consumed.actions).toContainEqual(
			expect.objectContaining({ op: "create-filter", name: "Shop - Orders" }),
		);
		expect(
			consumed.actions.some((action) => action.op === "update-filter" && action.id === "b"),
		).toBe(false);
		const duplicateFolders = buildSyncPlan(
			input({
				desiredFolders: [{ path: "fin", type: "folder" }],
				liveFolders: [folder("a", "fin"), folder("b", "fin")],
			}),
		);
		expect(duplicateFolders.actions).toContainEqual({
			op: "create-folder",
			path: "fin",
			type: "folder",
		});
		expect(duplicateFolders.notices.filter((notice) => notice.op === "drift")).toHaveLength(
			2,
		);
		const pulledName = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
				liveFilters: [
					proton("new", "Shop - Orders", "shop/orders"),
					proton("f1", "Fin - Banking"),
				],
				observedFilters: [proton("f1", "Fin - Banking")],
				pull: ["new"],
			}),
		);
		expect(pulledName.actions).toContainEqual({
			op: "reorder-filters",
			names: ["Fin - Banking", "Shop - Orders"],
			ids: ["f1", "new"],
		});
		expect(() =>
			buildSyncPlan(
				input({
					desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
					liveFilters: [
						proton("f1", "Fin - Banking"),
						proton("new", "Shop - Orders", "shop/orders"),
					],
					observedFilters: [proton("f1", "Fin - Banking")],
					pull: ["new"],
					revert: ["new"],
				}),
			),
		).toThrow("Choose pull or revert for Shop - Orders, not both");
	});
	test("reorders same-named filters by Proton ID", () => {
		const plan = buildSyncPlan(
			input({
				desiredFilters: [
					wanted("Fin - Banking", "fin/banking", "b"),
					wanted("Fin - Banking", "fin/banking", "a"),
				],
				liveFilters: [proton("a", "Fin - Banking"), proton("b", "Fin - Banking")],
			}),
		);
		expect(plan.actions).toContainEqual(
			expect.objectContaining({ op: "reorder-filters", ids: ["b", "a"] }),
		);
	});

	test("references a created filter explicitly in the reorder", () => {
		const plan = buildSyncPlan(
			input({
				desiredFilters: [
					wanted("Shop - Orders", "shop/orders"),
					wanted("Fin - Banking", "fin/banking", "a"),
				],
				liveFilters: [proton("a", "Fin - Banking")],
			}),
		);
		expect(plan.actions).toContainEqual(
			expect.objectContaining({ op: "create-filter", ref: "new:0" }),
		);
		expect(plan.actions).toContainEqual(
			expect.objectContaining({ op: "reorder-filters", ids: ["new:0", "a"] }),
		);
	});

	test("keeps a pulled rename at its declared position", () => {
		const plan = buildSyncPlan(
			input({
				desiredFilters: [
					wanted("A", "fin/banking", "a"),
					wanted("B", "shop/orders", "b"),
				],
				liveFilters: [proton("x", "X"), proton("b", "B", "shop/orders")].map(
					(filter) => (filter.id === "x" ? { ...filter, id: "a" } : filter),
				),
				observedFilters: [proton("a", "A"), proton("b", "B", "shop/orders")],
				pull: ["a"],
			}),
		);
		expect(plan.actions.some((action) => action.op === "reorder-filters")).toBe(false);
		expect(plan.actions).toContainEqual(
			expect.objectContaining({ op: "pull-filter", id: "a", name: "X" }),
		);
	});

	test("reports drift for a removed declaration that Proton changed since the baseline", () => {
		const kept = proton("f1", "Fin - Banking");
		const baseline = proton("new", "Shop - Orders", "shop/orders");
		const edited = proton("new", "Shop - Orders", "shop/orders", {
			sieve: sieve("shop/other"),
		});
		const base = {
			desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
			liveFilters: [kept, edited],
			observedFilters: [kept, baseline],
		};
		const plan = buildSyncPlan(input(base));
		expect(() => buildSyncPlan(input({ ...base, approveDelete: ["new"] }))).toThrow(
			"Unknown approve-delete target",
		);
		expect(plan.actions.some((action) => action.op === "delete-filter")).toBe(false);
		expect(plan.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "filter", id: "new" }),
		);
		expect(
			buildSyncPlan(input({ ...base, pull: ["new"] })).actions,
		).toContainEqual(expect.objectContaining({ op: "pull-filter", id: "new" }));
		expect(
			buildSyncPlan(input({ ...base, revert: ["new"], approveDelete: ["new"] }))
				.actions,
		).toContainEqual({ op: "delete-filter", id: "new", name: "Shop - Orders" });
	});

	test("reports drift for a removed folder that Proton renamed since the baseline", () => {
		const plan = buildSyncPlan(
			input({
				liveFolders: [folder("r1", "shop/renamed")],
				observedFolders: [folder("r1", "shop/orders")],
			}),
		);
		expect(plan.actions.some((action) => action.op === "delete-folder")).toBe(false);
		expect(plan.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "folder", id: "r1" }),
		);
	});

	test("appends pulled filters in live order", () => {
		const a = proton("a", "A");
		const b = proton("b", "B", "shop/orders");
		const c = proton("c", "C", "shop/receipts");
		const plan = buildSyncPlan(
			input({
				desiredFilters: [wanted("A", "fin/banking", "a")],
				liveFilters: [a, b, c],
				observedFilters: [a],
				pull: ["b", "c"],
			}),
		);
		expect(
			plan.actions
				.filter((action) => action.op === "pull-filter")
				.map((action) => action.id),
		).toEqual(["b", "c"]);
		expect(
			plan.actions.find((action) => action.op === "reorder-filters"),
		).toBeUndefined();
	});

	test("reports a filter deleted in Proton as drift instead of recreating it", () => {
		const base = {
			desiredFilters: [wanted("Fin - Banking", "fin/banking", "f1")],
			liveFilters: [],
			observedFilters: [proton("f1", "Fin - Banking")],
		};
		const drift = buildSyncPlan(input(base));
		expect(drift.actions).toEqual([]);
		expect(drift.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "filter", id: "f1" }),
		);
		const pulled = buildSyncPlan(input({ ...base, pull: ["f1"] }));
		expect(pulled.actions).toEqual([
			{ op: "drop-filter", id: "f1", name: "Fin - Banking" },
		]);
		const reverted = buildSyncPlan(input({ ...base, revert: ["f1"] }));
		expect(reverted.actions).toContainEqual(
			expect.objectContaining({ op: "create-filter", name: "Fin - Banking" }),
		);
		expect(reverted.notices).toEqual([]);
	});

	test("reports a folder deleted in Proton as drift instead of recreating it", () => {
		const base = {
			desiredFolders: [{ path: "fin", type: "folder" as const, protonId: "d1" }],
			liveFolders: [],
			observedFolders: [folder("d1", "fin")],
		};
		const drift = buildSyncPlan(input(base));
		expect(drift.actions).toEqual([]);
		expect(drift.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "folder", id: "d1" }),
		);
		expect(buildSyncPlan(input({ ...base, pull: ["d1"] })).actions).toEqual([
			{ op: "drop-folder", id: "d1", path: "fin" },
		]);
		expect(buildSyncPlan(input({ ...base, revert: ["d1"] })).actions).toEqual([
			{ op: "create-folder", path: "fin", type: "folder" },
		]);
	});

	test("reports drift instead of name-matching a replacement for a missing Proton ID", () => {
		const plan = buildSyncPlan(
			input({
				desiredFilters: [wanted("Fin - Banking", "fin/other", "f1")],
				liveFilters: [proton("f2", "Fin - Banking")],
				observedFilters: [proton("f1", "Fin - Banking")],
			}),
		);
		expect(plan.actions.some((action) => action.op === "update-filter")).toBe(false);
		expect(plan.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "filter", id: "f1" }),
		);
		const folders = buildSyncPlan(
			input({
				desiredFolders: [{ path: "fin", type: "folder" as const, protonId: "d1" }],
				liveFolders: [folder("d2", "fin")],
				observedFolders: [folder("d1", "fin")],
			}),
		);
		expect(folders.notices).toContainEqual(
			expect.objectContaining({ op: "drift", target: "folder", id: "d1" }),
		);
	});

	test("treats a reorder made only in Proton as drift", () => {
		const a = proton("a", "A");
		const b = proton("b", "B", "shop/orders");
		const base = {
			desiredFilters: [wanted("A", "fin/banking", "a"), wanted("B", "shop/orders", "b")],
			liveFilters: [b, a],
			observedFilters: [a, b],
		};
		const drift = buildSyncPlan(input(base));
		expect(drift.actions).toEqual([]);
		expect(drift.notices).toContainEqual(
			expect.objectContaining({ op: "drift", id: "filter-order" }),
		);
		expect(buildSyncPlan(input({ ...base, pull: ["filter-order"] })).actions).toEqual([
			{ op: "pull-filter-order", ids: ["b", "a"] },
		]);
		expect(buildSyncPlan(input({ ...base, revert: ["filter-order"] })).actions).toEqual([
			{ op: "reorder-filters", names: ["A", "B"], ids: ["a", "b"] },
		]);
	});
});
