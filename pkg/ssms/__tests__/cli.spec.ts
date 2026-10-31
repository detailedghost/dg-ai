import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHelp } from "../src/cli/catalog";
import { runSsms } from "../src/cli/run";
import { createLocalMessagesBrowser } from "../src/google/browser";
import { connectJsonRpc } from "../src/signal/rpc";
import { createDocument, node } from "./support/document";
import { startFakeSignalServer } from "./support/rpc";

function googleRuntime(home: string) {
	const doc = createDocument(
		[
			node("", {
				"data-conversation-id": "promo",
				"data-sender": "Shop",
				"data-preview": "sale ends 50% off",
			}),
			node("", {
				"data-conversation-id": "keep",
				"data-sender": "Ada",
				"data-preview": "hello",
				"data-pinned": "true",
			}),
			node("Options"),
			node("Archive"),
			node("Delete"),
			node("Send"),
			node("", { "data-compose": "true" }),
		],
		"Conversations",
	);
	return {
		home,
		browser: createLocalMessagesBrowser(doc),
		ids: () => "draft-1",
		now: () => Date.parse("2026-10-31T00:00:00Z"),
		env: {},
	};
}

describe("ssms cli", () => {
	test("help lists both providers and the send gate", async () => {
		const result = await runSsms(["--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(renderHelp());
		for (const line of ["ssms <provider> link [--name NAME]", "ssms google cleanup [--dry-run] [--config PATH]", "ssms <provider> send --draft ID [--yes]"]) {
			expect(result.stdout).toContain(line);
		}
		expect(result.stdout).toContain("google");
		expect(result.stdout).toContain("signal");
		expect(result.stdout).toContain("DG_HOOK");
	});

	test("google cleanup archives the promo and does not delete or send", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-cli-"));
		const result = await runSsms(["google", "cleanup", "--json"], googleRuntime(home));
		expect(result.code).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.deleted).toBe(0);
		expect(body.actions.find((item: { id: string }) => item.id === "promo")).toMatchObject({
			disposition: "archive",
			applied: true,
		});
		expect(body.actions.find((item: { id: string }) => item.id === "keep").applied).toBe(false);
		expect(result.stderr).not.toContain("sale ends");
	});

	test("a draft is not sent until --yes, and a hook cannot send", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-draft-"));
		const runtime = googleRuntime(home);
		const drafted = await runSsms(
			["google", "draft", "--conversation", "keep", "--text", "hello there"],
			runtime,
		);
		expect(drafted.code).toBe(0);
		expect(drafted.stdout).toContain("draft draft-1");
		expect(drafted.stdout).toContain("hello there");
		expect(drafted.stderr).not.toContain("hello there");
		const refused = await runSsms(["google", "send", "--draft", "draft-1"], runtime);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("send requires --yes");
		expect(refused.stdout).not.toContain("sent ");
		const hooked = await runSsms(["google", "send", "--draft", "draft-1", "--yes"], {
			...runtime,
			env: { DG_HOOK: "1" },
		});
		expect(hooked.code).toBe(1);
		expect(hooked.stderr).toContain("hook");
		const sent = await runSsms(["google", "send", "--draft", "draft-1", "--yes"], runtime);
		expect(sent.code).toBe(0);
		expect(sent.stdout).toContain("sent draft-1");
	});

	test("signal link output contains the URI and the log does not", async () => {
		const server = await startFakeSignalServer((method) => {
			if (method === "startLink") return { deviceLinkUri: "sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY" };
			if (method === "finishLink") return { aci: "acct-1", number: "+15555550123" };
			throw new Error(method);
		});
		const rpc = await connectJsonRpc(server.port);
		const home = mkdtempSync(join(tmpdir(), "ssms-cli-signal-"));
		const result = await runSsms(["signal", "link", "--name", "dg-cli"], { home, rpc, env: {} });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY");
		expect(result.stdout.split("\n").some((line) => /[█▄▀]/.test(line))).toBe(true);
		expect(result.stderr).not.toContain("sgnl://");
		expect(result.stderr).not.toContain("SECRETKEY");
		expect(result.stderr).not.toContain("+15555550123");
		expect(server.calls[1]?.params).toMatchObject({ deviceName: "dg-cli" });
		await rpc.close();
		await server.close();
	});

	test("a missing signal-cli prints the install hint and does not spawn", async () => {
		let spawned = 0;
		const result = await runSsms(["signal", "status"], {
			env: {},
			which: () => null,
			exists: () => false,
			spawn: () => {
				spawned += 1;
				throw new Error("spawned");
			},
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("sudo pacman -S signal-cli");
		expect(result.stderr).toContain("will not install");
		expect(result.stderr).toContain("missing-binary");
		expect(spawned).toBe(0);
	});

	test("delete is rejected", async () => {
		const result = await runSsms(["google", "delete"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("delete is disabled");
	});
});

describe("config file", () => {
	test("a yaml config forces dry-run", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-cfg-"));
		const config = join(home, "cleanup.yaml");
		writeFileSync(config, "dry_run: true\nallow_delete: true\n");
		const result = await runSsms(["google", "cleanup", "--config", config, "--json"], googleRuntime(home));
		expect(result.code).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.actions.every((item: { applied: boolean }) => item.applied === false)).toBe(true);
		expect(body.deleted).toBe(0);
		expect(body.allowDelete).toBe(true);
	});
});
