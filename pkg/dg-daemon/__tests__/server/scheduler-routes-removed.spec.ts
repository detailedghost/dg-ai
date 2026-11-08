import { afterEach, describe, expect, it } from "bun:test";
import {
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	stopServe,
} from "../utils/daemon-harness";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function boot(): Promise<number> {
	const { dgHome, port, proc } = await bootServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return port;
}

describe("retired scheduler routes", () => {
	it.each([
		["GET", "/jobs"],
		["POST", "/jobs/job-1/run"],
		["GET", "/feed"],
		["POST", "/feed/read-all"],
		["POST", "/feed/item-1/read"],
	])("answers %s %s with 404", async (method, path) => {
		const port = await boot();

		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			headers: { Host: `127.0.0.1:${port}`, Origin: EXTENSION_ORIGIN },
		});

		expect(response.status).toBe(404);
	});
});
