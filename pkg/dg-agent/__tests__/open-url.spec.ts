import { afterEach, describe, expect, it } from "bun:test";
import { type OpenSeams, openFailedHint } from "@dg/common/node";
import { openUrlOrHint, tryOpenAgentUrl } from "../src/start";

const URL_TO_OPEN = "http://127.0.0.1:47823/chat#_chat=abc";
const originalError = console.error;

afterEach(() => {
	console.error = originalError;
});

function captureErrors(): string[] {
	const errors: string[] = [];
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	};
	return errors;
}

describe("openUrlOrHint", () => {
	it("opens the URL through the tryOpen seam and writes nothing", async () => {
		const errors = captureErrors();
		const opened: string[] = [];

		await openUrlOrHint(URL_TO_OPEN, {
			tryOpen: async (url) => {
				opened.push(url);
				return true;
			},
			openFailedHint: () => openFailedHint(true),
		});

		expect(opened).toEqual([URL_TO_OPEN]);
		expect(errors).toEqual([]);
	});

	it("writes the WSL opt-in hint when no launcher ran", async () => {
		const errors = captureErrors();

		await openUrlOrHint(URL_TO_OPEN, {
			tryOpen: async () => false,
			openFailedHint: () => openFailedHint(true),
		});

		expect(errors).toEqual([
			"could not open a browser (set DG_OPEN_WINDOWS=1 to open the Windows browser)",
		]);
	});
});

describe("tryOpenAgentUrl", () => {
	function fakeSpawn() {
		const commands: string[] = [];
		const spawn: NonNullable<OpenSeams["spawn"]> = (command) => {
			commands.push(command);
			const listeners = new Map<string, () => void>();
			queueMicrotask(() => listeners.get("spawn")?.());
			return {
				on(event: "error" | "spawn", listener: () => void) {
					listeners.set(event, listener);
				},
				unref() {},
			};
		};
		return { commands, spawn };
	}

	it("launches nothing on WSL without DG_OPEN_WINDOWS=1", async () => {
		const { commands, spawn } = fakeSpawn();

		const opened = await tryOpenAgentUrl(URL_TO_OPEN, {
			platform: "linux",
			wsl: true,
			env: {},
			spawn,
		});

		expect(opened).toBe(false);
		expect(commands).toEqual([]);
	});

	it("opens the Windows browser on WSL with DG_OPEN_WINDOWS=1", async () => {
		const { commands, spawn } = fakeSpawn();

		const opened = await tryOpenAgentUrl(URL_TO_OPEN, {
			platform: "linux",
			wsl: true,
			env: { DG_OPEN_WINDOWS: "1" },
			spawn,
		});

		expect(opened).toBe(true);
		expect(commands).toEqual(["wslview"]);
	});

	it("keeps xdg-open on Linux outside WSL", async () => {
		const { commands, spawn } = fakeSpawn();

		await tryOpenAgentUrl(URL_TO_OPEN, {
			platform: "linux",
			wsl: false,
			env: {},
			spawn,
		});

		expect(commands).toEqual(["xdg-open"]);
	});
});

