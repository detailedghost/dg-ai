import { describe, expect, it, mock } from "bun:test";
import {
	defineLocalMailboxInferenceAdapter,
	runLocalMailboxInference,
} from "../index";

function inventory() {
	return {
		schemaVersion: 1 as const,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: "acct_00112233445566778899aabbccddeeff",
		runAlias: "run_102132435465768798a9bacbdcedfe0f",
		capturedAt: "2026-07-27T12:00:00.000Z",
		partial: false,
		messages: [
			{
				alias: "msg_89abcdef01234567fedcba9876543210",
				read: false,
				hasAttachments: false,
				receivedAt: "2026-07-26T12:00:00.000Z",
				category: "transactional" as const,
			},
		],
		folders: [],
		labels: [],
		filters: [],
	};
}

describe("local mailbox inference contract", () => {
	it("passes validated scrubbed inventory and accepts advisory output", async () => {
		const infer = mock(() => ({
			schemaVersion: 1,
			hints: [
				{
					cohortKey: "older-transactional",
					classification: "archive_candidate",
					confidence: 0.75,
				},
			],
		}));

		await expect(
			runLocalMailboxInference(
				{ id: "local-hints", kind: "local", infer },
				{ schemaVersion: 1, inventory: inventory() },
			),
		).resolves.toMatchObject({
			schemaVersion: 1,
			hints: [
				{
					provenance: {
						source: "validated_local",
						validatedAt: expect.any(String),
					},
				},
			],
		});
		expect(infer).toHaveBeenCalledWith({
			schemaVersion: 1,
			inventory: inventory(),
		});
	});

	it("rejects raw input channels and mutation authority in output", async () => {
		const adapter = {
			id: "local-hints",
			kind: "local" as const,
			infer: () => ({
				schemaVersion: 1,
				hints: [
					{
						cohortKey: "older-transactional",
						classification: "archive_candidate",
						confidence: 0.75,
						accepted: true,
					},
				],
			}),
		};

		await expect(
			runLocalMailboxInference(adapter, {
				schemaVersion: 1,
				inventory: inventory(),
				rawMessages: [{ subject: "sensitive" }],
			} as never),
		).rejects.toThrow(/input/i);
		await expect(
			runLocalMailboxInference(adapter, {
				schemaVersion: 1,
				inventory: inventory(),
			}),
		).rejects.toThrow(/output/i);
		expect(() =>
			defineLocalMailboxInferenceAdapter({
				...adapter,
				endpoint: "https://example.test/model",
			} as never),
		).toThrow(/adapter/i);
	});

	it("rejects model-authored provenance before attaching trusted provenance", async () => {
		await expect(
			runLocalMailboxInference(
				{
					id: "local-hints",
					kind: "local",
					infer: () => ({
						schemaVersion: 1,
						hints: [
							{
								cohortKey: "older-transactional",
								classification: "archive_candidate",
								confidence: 0.75,
								provenance: {
									source: "validated_local",
									validated: true,
								},
							},
						],
					}),
				},
				{ schemaVersion: 1, inventory: inventory() },
			),
		).rejects.toThrow(/output/i);
	});
});
