import { describe, expect, test } from "bun:test";
import { CHAT_DEFAULT_PORT } from "@dg/common";
import {
	type ChatHealth,
	findPinnedDaemonPort,
	portHasDaemonId,
} from "../src/daemon-port";

function probeOf(byPort: Record<number, Partial<ChatHealth>>) {
	return async (port: number): Promise<ChatHealth | undefined> => {
		const health = byPort[port];
		return health
			? { daemon: "dg-daemon", instanceId: `instance-${port}`, ...health }
			: undefined;
	};
}

describe("findPinnedDaemonPort", () => {
	test("returns the port whose daemon reports the pinned daemonId", async () => {
		const probe = probeOf({
			[CHAT_DEFAULT_PORT]: { daemonId: "squatter" },
			[CHAT_DEFAULT_PORT + 2]: { daemonId: "real" },
		});

		expect(await findPinnedDaemonPort("real", probe)).toBe(CHAT_DEFAULT_PORT + 2);
	});

	test("returns undefined when only other daemons answer", async () => {
		const probe = probeOf({
			[CHAT_DEFAULT_PORT]: { daemonId: "squatter" },
			[CHAT_DEFAULT_PORT + 1]: {},
		});

		expect(await findPinnedDaemonPort("real", probe)).toBeUndefined();
	});
});

describe("portHasDaemonId", () => {
	test("accepts a matching daemonId and refuses a mismatch or a silent port", async () => {
		const probe = probeOf({
			[CHAT_DEFAULT_PORT]: { daemonId: "real" },
			[CHAT_DEFAULT_PORT + 1]: { daemonId: "squatter" },
		});

		expect(await portHasDaemonId(CHAT_DEFAULT_PORT, "real", probe)).toBe(true);
		expect(await portHasDaemonId(CHAT_DEFAULT_PORT + 1, "real", probe)).toBe(false);
		expect(await portHasDaemonId(CHAT_DEFAULT_PORT + 2, "real", probe)).toBe(false);
	});
});
