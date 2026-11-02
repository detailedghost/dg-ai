import { afterEach, describe, expect, it } from "bun:test";
import { DispatchScheduler, dispatchCommand } from "../../src/dispatch";
import { DISPATCH_MAX_CONCURRENT_PER_SESSION } from "../../src/dispatch/limits";

import { freshTempDir, removeScratchDirs } from "../utils/daemon-harness";

afterEach(removeScratchDirs);

const SESSION = "session-admission";

function deps(insertThrows: boolean, scheduler: DispatchScheduler) {
	const cwd = freshTempDir("dg-admission");
	return {
		scheduler,
		registry: {
			get: () => ({ sessionId: SESSION, cwd, state: "active" as const }),
		},
		store: {
			getCommandManifest: () => [
				{ label: "Echo", argv: ["echo", "ok"], params: [] },
			],
			insertCommandInvocation: () => {
				if (insertThrows) throw new Error("disk full");
				return { seq: 1 };
			},
			updateCommandInvocationResult: () => undefined,
		},
	} as unknown as Parameters<typeof dispatchCommand>[3];
}

describe("dispatch admission accounting", () => {
	it("releases the admission when the audit-row insert throws, so later commands are not refused as at capacity", async () => {
		const scheduler = new DispatchScheduler();

		for (let i = 0; i < DISPATCH_MAX_CONCURRENT_PER_SESSION + 1; i++) {
			const attempt = dispatchCommand(
				SESSION,
				"Echo",
				{},
				deps(true, scheduler),
			);
			await expect(attempt).rejects.toThrow("disk full");
		}

		const after = await dispatchCommand(
			SESSION,
			"Echo",
			{},
			deps(false, scheduler),
		);

		expect(after.ok).toBe(true);
	});
});
