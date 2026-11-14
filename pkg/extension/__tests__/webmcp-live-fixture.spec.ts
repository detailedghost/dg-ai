import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { isDgToolName, WEBMCP_SCRIPT_MAX_BYTES } from "@dg/common";
import { installModelContextShim } from "@/lib/features/webmcp-shim";

const code = readFileSync(join(import.meta.dir, "fixtures/webmcp-live/dummy-tools.js"), "utf8");

let window: Window | undefined;

afterEach(async () => {
	await window?.happyDOM.close();
	window = undefined;
});

function run(url: string, shim = true) {
	window = new Window({ url });
	const doc = window.document as unknown as Document;
	const context = shim ? installModelContextShim(doc) : undefined;
	new Function("document", code)(doc);
	return context;
}

describe("Web MCP live fixture script", () => {
	it("registers four dg_ tools on the shim, within the script size limit", async () => {
		const context = run("http://localhost:8765/");

		const names = (await context!.getTools()).map((tool) => tool.name);

		expect(names).toEqual(["dg_outlook_list", "dg_outlook_move", "dg_outlook_delete", "dg_fixture_echo"]);
		expect(names.every(isDgToolName)).toBe(true);
		expect(new TextEncoder().encode(code).length).toBeLessThan(WEBMCP_SCRIPT_MAX_BYTES);
	});

	it("returns fixed strings that hold no page data", async () => {
		const context = run("http://localhost:8765/");

		expect(await context!.executeTool({ name: "dg_outlook_move", description: "" }, { id: "fixture-2" }, {})).toBe(
			"Fixture: moved fixture-2 to Archive. Nothing changed.",
		);
		expect(await context!.executeTool({ name: "dg_fixture_echo", description: "" }, { text: "hi" }, {})).toBe('Fixture echo: {"text":"hi"}');
	});

	it("fails loudly when the shim was not injected first", () => {
		expect(() => run("http://localhost:8765/", false)).toThrow("did not inject the Web MCP shim");
	});
});
