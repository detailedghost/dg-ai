import { describe, expect, it } from "bun:test";
import {
	getExtensionCredential,
	listExtensionCredentials,
} from "../lib/background/credentials";

function fakeSocket(reply: (frame: Record<string, unknown>) => unknown) {
	const target = new EventTarget();
	const sent: Record<string, unknown>[] = [];
	return {
		sent,
		addEventListener: target.addEventListener.bind(target),
		removeEventListener: target.removeEventListener.bind(target),
		send(data: string) {
			const frame = JSON.parse(data);
			sent.push(frame);
			queueMicrotask(() =>
				target.dispatchEvent(
					new MessageEvent("message", { data: JSON.stringify(reply(frame)) }),
				),
			);
		},
	} as unknown as WebSocket & { sent: Record<string, unknown>[] };
}

describe("extension credential client", () => {
	it("sends a correlated get and returns the record", async () => {
		const record = { value: "fixture", meta: {}, updatedAt: "2026-01-01" };
		const socket = fakeSocket((frame) => ({
			type: "cli-credentials-result",
			requestId: frame.requestId,
			ok: true,
			value: record,
		}));
		expect(await getExtensionCredential(socket, "extension/example")).toEqual(
			record,
		);
		expect(socket.sent[0]).toMatchObject({
			type: "cli-credentials-request",
			operation: "get",
			name: "extension/example",
		});
	});

	it("maps a missing credential to undefined and lists entries", async () => {
		const socket = fakeSocket((frame) => ({
			type: "cli-credentials-result",
			requestId: frame.requestId,
			ok: true,
			value: frame.operation === "list" ? [] : null,
		}));
		expect(
			await getExtensionCredential(socket, "extension/missing"),
		).toBeUndefined();
		expect(await listExtensionCredentials(socket)).toEqual([]);
	});

	it("rejects with the daemon error", async () => {
		const socket = fakeSocket((frame) => ({
			type: "cli-credentials-result",
			requestId: frame.requestId,
			ok: false,
			error: "Credential request not allowed for this caller.",
		}));
		await expect(
			getExtensionCredential(socket, "other/example"),
		).rejects.toThrow(/not allowed/);
	});
});
