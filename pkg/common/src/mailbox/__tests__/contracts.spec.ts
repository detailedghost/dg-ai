import { describe, expect, it } from "bun:test";
import {
	attachMailboxHintProvenance,
	preflightMailboxValue,
	serializeMailboxInventory,
	validateMailboxAction,
	validateMailboxCohort,
	validateMailboxInferenceOutput,
	validateMailboxInventory,
	validateMailboxPlanRevision,
} from "../index";

const PAYLOAD = "0123456789abcdef0123456789abcdef";

function opaqueAlias(prefix: string, offset = 0): string {
	const rotated = `${PAYLOAD.slice(offset)}${PAYLOAD.slice(0, offset)}`;
	return `${prefix}_${rotated}`;
}

const ACCOUNT_ALIAS = opaqueAlias("acct");
const RUN_ALIAS = opaqueAlias("run", 1);
const MESSAGE_ALIAS = opaqueAlias("msg", 2);
const OTHER_MESSAGE_ALIAS = opaqueAlias("msg", 3);
const FOLDER_ALIAS = opaqueAlias("fld", 4);
const OTHER_FOLDER_ALIAS = opaqueAlias("fld", 5);
const LABEL_ALIAS = opaqueAlias("lbl", 6);
const OTHER_LABEL_ALIAS = opaqueAlias("lbl", 7);
const FILTER_ALIAS = opaqueAlias("flt", 8);
const OTHER_FILTER_ALIAS = opaqueAlias("flt", 9);

function inventory(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		runAlias: RUN_ALIAS,
		capturedAt: "2026-07-27T12:00:00.000Z",
		partial: false,
		messages: [
			{
				alias: MESSAGE_ALIAS,
				read: false,
				hasAttachments: false,
				receivedAt: "2026-07-26T12:00:00.000Z",
				category: "transactional",
			},
		],
		folders: [],
		labels: [],
		filters: [],
		...overrides,
	};
}

function revision(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		planAlias: opaqueAlias("plan", 10),
		revisionAlias: opaqueAlias("rev", 11),
		revisionNumber: 1,
		state: "draft",
		restartRequired: false,
		createdAt: "2026-07-27T12:00:00.000Z",
		inventoryFingerprint: {
			schemaVersion: 1,
			algorithm: "sha256",
			digest: "ab".repeat(32),
		},
		cohorts: [
			{
				schemaVersion: 1,
				cohortKey: "older-transactional",
				category: "transactional",
				ageBucket: "older",
				messageAliases: [MESSAGE_ALIAS],
				suggestedActions: [
					{ type: "archive", messageAlias: MESSAGE_ALIAS },
				],
			},
		],
		targets: {
			folderAliases: [FOLDER_ALIAS],
			labelAliases: [LABEL_ALIAS],
			filterAliases: [FILTER_ALIAS],
		},
		actions: [
			{
				type: "move_to_folder",
				messageAlias: MESSAGE_ALIAS,
				folderAlias: FOLDER_ALIAS,
			},
			{
				type: "apply_label",
				messageAlias: MESSAGE_ALIAS,
				labelAlias: LABEL_ALIAS,
			},
			{ type: "deactivate_filter", filterAlias: FILTER_ALIAS },
		],
		...overrides,
	};
}

describe("mailbox boundary contracts", () => {
	it("rejects unknown, pollution, cyclic, and non-plain input", () => {
		expect(() =>
			validateMailboxInventory(inventory({ unexpected: true })),
		).toThrow(/unknown/i);

		const polluted = inventory();
		Object.defineProperty(polluted.messages[0], "__proto__", {
			enumerable: true,
			value: { polluted: true },
		});
		expect(() => validateMailboxInventory(polluted)).toThrow(/prototype/i);

		const cyclic = inventory() as Record<string, unknown>;
		cyclic.self = cyclic;
		expect(() => validateMailboxInventory(cyclic)).toThrow(/cycl|unknown/i);

		expect(() =>
			validateMailboxInventory(
				Object.assign(Object.create({ inherited: true }), inventory()),
			),
		).toThrow(/plain/i);
	});

	it("rejects unsafe action authority and every destructive action", () => {
		expect(() =>
			validateMailboxAction({
				type: "archive",
				messageAlias: MESSAGE_ALIAS,
				selector: "#raw-message",
			}),
		).toThrow(/unknown|selector/i);

		for (const type of ["delete", "trash", "remove_message", "empty_trash"]) {
			expect(() =>
				validateMailboxAction({ type, messageAlias: MESSAGE_ALIAS }),
			).toThrow(/action|type/i);
		}
	});

	it("serializes validated inventories deterministically", () => {
		const left = inventory();
		const right = {
			...left,
			messages: left.messages.map((message) => ({
				category: message.category,
				receivedAt: message.receivedAt,
				hasAttachments: message.hasAttachments,
				read: message.read,
				alias: message.alias,
			})),
		};

		expect(serializeMailboxInventory(left)).toBe(
			serializeMailboxInventory(right),
		);
		expect(serializeMailboxInventory(left)).toEndWith("\n");
		expect(() =>
			serializeMailboxInventory({ arbitrary: "value" }),
		).toThrow(/unknown|missing/i);
	});

	it("rejects accessors, symbols, excessive depth and size, and non-finite numbers", () => {
		let accessorRead = false;
		const accessor = Object.defineProperty({}, "secret", {
			enumerable: true,
			get() {
				accessorRead = true;
				return "must-not-be-read";
			},
		});
		expect(() => preflightMailboxValue(accessor)).toThrow(/accessor/i);
		expect(accessorRead).toBe(false);

		expect(() =>
			preflightMailboxValue({ [Symbol("secret")]: "value" }),
		).toThrow(/symbol/i);
		expect(() =>
			preflightMailboxValue({ nested: { value: true } }, { maxDepth: 1 }),
		).toThrow(/depth/i);
		expect(() =>
			preflightMailboxValue("oversized", { maxStringLength: 4 }),
		).toThrow(/size/i);
		expect(() => preflightMailboxValue(Number.POSITIVE_INFINITY)).toThrow(
			/finite/i,
		);
	});

	it("rejects duplicate aliases and cohort actions with broken references", () => {
		const duplicate = inventory();
		expect(() =>
			validateMailboxInventory({
				...duplicate,
				messages: [duplicate.messages[0], duplicate.messages[0]],
			}),
		).toThrow(/duplicate/i);

		expect(() =>
			validateMailboxCohort({
				schemaVersion: 1,
				cohortKey: "older-transactional",
				category: "transactional",
				ageBucket: "older",
				messageAliases: [MESSAGE_ALIAS],
				suggestedActions: [
					{
						type: "archive",
						messageAlias: OTHER_MESSAGE_ALIAS,
					},
				],
			}),
		).toThrow(/reference/i);
	});

	it("rejects raw, encoded, Unicode, and low-entropy aliases", () => {
		for (const invalidAlias of [
			"msg_alice@example.test",
			"msg_%61%6c%69%63%65",
			`msg_\u0430${"a".repeat(31)}`,
			"msg_616c696365406578616d706c652e636f",
			`msg_${"a".repeat(32)}`,
		]) {
			expect(() =>
				validateMailboxAction({
					type: "archive",
					messageAlias: invalidAlias,
				}),
			).toThrow(/alias/i);
		}
	});

	it("rejects duplicate and broken revision action references", () => {
		const brokenActions = [
			{ type: "archive", messageAlias: OTHER_MESSAGE_ALIAS },
			{
				type: "move_to_folder",
				messageAlias: MESSAGE_ALIAS,
				folderAlias: OTHER_FOLDER_ALIAS,
			},
			{
				type: "apply_label",
				messageAlias: MESSAGE_ALIAS,
				labelAlias: OTHER_LABEL_ALIAS,
			},
			{
				type: "deactivate_filter",
				filterAlias: OTHER_FILTER_ALIAS,
			},
		];
		for (const action of brokenActions) {
			expect(() =>
				validateMailboxPlanRevision(
					revision({ actions: [action] }),
				),
			).toThrow(/reference/i);
		}

		const validAction = {
			type: "archive",
			messageAlias: MESSAGE_ALIAS,
		};
		expect(() =>
			validateMailboxPlanRevision(
				revision({ actions: [validAction, validAction] }),
			),
		).toThrow(/duplicate/i);
		expect(() =>
			validateMailboxPlanRevision(
				revision({
					targets: {
						folderAliases: [FOLDER_ALIAS, FOLDER_ALIAS],
						labelAliases: [LABEL_ALIAS],
						filterAliases: [FILTER_ALIAS],
					},
				}),
			),
		).toThrow(/duplicate/i);
	});

	it("keeps local inference output advisory, alias-free, and untrusted", () => {
		expect(() =>
			validateMailboxInferenceOutput({
				schemaVersion: 1,
				hints: [
					{
						cohortKey: "older-transactional",
						classification: "archive_candidate",
						confidence: 0.8,
						messageAlias: MESSAGE_ALIAS,
					},
				],
			}),
		).toThrow(/unknown|alias/i);

		expect(() =>
			validateMailboxInferenceOutput({
				schemaVersion: 1,
				hints: [
					{
						cohortKey: "older-transactional",
						classification: "archive_candidate",
						confidence: 0.8,
						accepted: true,
					},
				],
			}),
		).toThrow(/unknown|accepted/i);

		for (const authority of [
			{ validated: true },
			{
				provenance: {
					source: "validated_local",
					validatedAt: "2026-07-27T12:00:00.000Z",
				},
			},
			{
				provenance: {
					source: "core_rules",
					validatedAt: "2026-07-27T12:00:00.000Z",
				},
			},
		]) {
			expect(() =>
				validateMailboxInferenceOutput({
					schemaVersion: 1,
					hints: [
						{
							cohortKey: "older-transactional",
							classification: "archive_candidate",
							confidence: 0.8,
							...authority,
						},
					],
				}),
			).toThrow(/unknown/i);
		}

		const validated = attachMailboxHintProvenance(
			{
				cohortKey: "older-transactional",
				classification: "archive_candidate",
				confidence: 0.8,
			},
			{
				source: "validated_local",
				validatedAt: "2026-07-27T12:00:00.000Z",
			},
		);
		expect(validated.provenance.source).toBe("validated_local");
	});
});
