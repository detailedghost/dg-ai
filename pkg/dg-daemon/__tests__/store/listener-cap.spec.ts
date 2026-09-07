import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { SESSION_MAX_ACTIVE_DEFAULT } from "../../src/session/limits";
import { CHAT_STORE_MESSAGE_EVENT, ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

describe("ChatStore listener cap", () => {
	it("lets every session hold a blocked cli-recv waiter without warning about a leak", async () => {
		const dgHome = freshDgHome();
		const warnings: string[] = [];
		const onWarning = (warning: Error) => warnings.push(warning.name);
		process.on("warning", onWarning);
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const waiters = Array.from({ length: 64 }, () => () => {});
			for (const waiter of waiters) {
				store.on(CHAT_STORE_MESSAGE_EVENT, waiter);
			}

			await new Promise((resolve) => setImmediate(resolve));

			expect(warnings).not.toContain("MaxListenersExceededWarning");
			expect(store.getMaxListeners()).toBeGreaterThanOrEqual(
				SESSION_MAX_ACTIVE_DEFAULT,
			);

			for (const waiter of waiters) {
				store.off(CHAT_STORE_MESSAGE_EVENT, waiter);
			}
			store.close();
		} finally {
			process.off("warning", onWarning);
			cleanupDgHome(dgHome);
		}
	});
});
