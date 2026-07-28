import { describe, expect, it } from "bun:test";
import {
	monitorMailboxPlansCliSession,
	type MailboxCliConnection,
} from "@/lib/features/mailbox-cleanup/cli-transport";

const connection: MailboxCliConnection = Object.freeze({
	schemaVersion: 1,
	origin: "http://127.0.0.1:49152",
	runAlias: "run_00112233445566778899aabbccddeeff",
	nonce: "102132435465768798a9bacbdcedfe0f",
	token:
		"2031425364758697a8b9cadbecfd0e1f" +
		"30415263748596a7b8c9daebfc0d1e2f",
	purpose: "plans",
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Mailbox plans monitor did not reach expected state");
}

describe("monitorMailboxPlansCliSession", () => {
	it("aborts after an authenticated loopback probe disconnects", async () => {
		let calls = 0;
		const monitor = monitorMailboxPlansCliSession(
			connection,
			{
				extensionOrigin: "chrome-extension://dgtest",
				async fetch(input, init) {
					calls += 1;
					expect(input).toBe(
						`${connection.origin}/mailbox-cleanup/v1/status/${connection.runAlias}`,
					);
					expect(init).toMatchObject({
						method: "POST",
						body: "{}",
						credentials: "omit",
					});
					expect(init.headers).toMatchObject({
						authorization: `Bearer ${connection.token}`,
						"x-dg-mailbox-nonce": connection.nonce,
					});
					if (calls === 1) return new Response(null, { status: 204 });
					throw new Error("Loopback closed");
				},
			},
			{
				intervalMs: 10,
				requestTimeoutMs: 50,
				maxDurationMs: 500,
			},
		);
		try {
			await waitFor(() => monitor.signal.aborted);
			expect(calls).toBe(2);
		} finally {
			monitor.dispose();
		}
	});

	it("disposes an active probe without falsely canceling completed work", async () => {
		let probeAborted = false;
		let calls = 0;
		const monitor = monitorMailboxPlansCliSession(
			connection,
			{
				extensionOrigin: "chrome-extension://dgtest",
				fetch(_input, init) {
					calls += 1;
					return new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener(
							"abort",
							() => {
								probeAborted = true;
								reject(new DOMException("Aborted", "AbortError"));
							},
							{ once: true },
						);
					});
				},
			},
			{
				intervalMs: 10,
				requestTimeoutMs: 500,
				maxDurationMs: 1_000,
			},
		);
		await waitFor(() => calls === 1);
		monitor.dispose();
		await waitFor(() => probeAborted);
		expect(monitor.signal.aborted).toBe(false);
		expect(calls).toBe(1);
	});
});
