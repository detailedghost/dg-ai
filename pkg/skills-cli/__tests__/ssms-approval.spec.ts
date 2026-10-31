import { describe, expect, test } from "bun:test";
import { ssmsCommandRuntime } from "../src/commands/ssms";

describe("ssms interactive approval", () => {
	test("a real terminal prompts, and a non-terminal does not", async () => {
		const headless = ssmsCommandRuntime({ isTTY: false, once: () => undefined });
		expect(headless.stdinIsTTY).toBe(false);
		expect(headless.ask).toBeUndefined();
		let prompted = "";
		const chunks: Array<(chunk: Uint8Array) => void> = [];
		const tty = ssmsCommandRuntime({
			isTTY: true,
			once: (_event, listener) => {
				chunks.push(listener);
			},
		});
		expect(tty.stdinIsTTY).toBe(true);
		expect(tty.ask).toBeTypeOf("function");
		const pending = tty.ask?.("d1");
		chunks[0]?.(new TextEncoder().encode("yes\n"));
		expect(await pending).toBe(true);
		expect(prompted).toBe("");
	});
});
