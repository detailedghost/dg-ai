import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main";
import skillsTree from "../src/completion/tree.json";
import { overrideApprovalKeys } from "../src/plugin/approval";
import { downKeys, fakeKeys } from "./support/approval-keys";

const realOut = process.stdout.write;
const realHome = process.env.DG_HOME;
const realFence = process.env.DG_PATH_FENCE;
const realExitCode = process.exitCode;
let root: string;
let out: string[];
let err: string[];
const realConsoleError = console.error;

beforeEach(() => {
	overrideApprovalKeys(fakeKeys());
	root = mkdtempSync(join(tmpdir(), "dg-plugin-command-"));
	process.env.DG_HOME = join(root, "dg");
	process.env.DG_PATH_FENCE = root;
	out = [];
	err = [];
	console.error = (...parts: unknown[]) => void err.push(`${parts.join(" ")}\n`);
	process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
	process.exitCode = 0;
});

afterEach(() => {
	overrideApprovalKeys(undefined);
	process.stdout.write = realOut;
	console.error = realConsoleError;
	process.exitCode = realExitCode ?? 0;
	if (realHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = realHome;
	if (realFence === undefined) delete process.env.DG_PATH_FENCE;
	else process.env.DG_PATH_FENCE = realFence;
	rmSync(root, { recursive: true, force: true });
});

function folderSource(): string {
	const dir = join(root, "src", "notes");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "# Notes\n");
	return dir;
}

const realIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function setStdinTTY(value: boolean | undefined): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

afterEach(() => {
	if (realIsTTY) Object.defineProperty(process.stdin, "isTTY", realIsTTY);
	else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe("dg plugin", () => {
	test("add, list, verify --approve, enable and remove run end to end", async () => {
		const source = folderSource();
		await main(["plugin", "add", source]);
		expect(out.join("")).toMatch(/notes.*skill.*sha256:[0-9a-f]{64}/);
		expect(out.join("")).toMatch(/dg plugin verify notes --approve/);
		out.length = 0;
		await main(["plugin", "list"]);
		expect(out.join("")).toMatch(/notes\s+skill\s+off\s+unapproved/);
		out.length = 0;
		setStdinTTY(true);
		await main(["plugin", "verify", "notes", "--approve"]);
		expect(out.join("")).toMatch(/approved/);
		await main(["plugin", "enable", "notes"]);
		out.length = 0;
		await main(["plugin", "list", "--json"]);
		expect(JSON.parse(out.join(""))).toEqual([expect.objectContaining({ name: "notes", enabled: true, approved: true })]);
		await main(["plugin", "remove", "notes"]);
		out.length = 0;
		await main(["plugin", "list"]);
		expect(out.join("")).toMatch(/no plugins/i);
	});

	test("verify --approve refuses to run without a terminal on stdin", async () => {
		await main(["plugin", "add", folderSource()]);
		setStdinTTY(false);
		const written: string[] = [];
		const realErr = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
		try {
			await main(["plugin", "verify", "notes", "--approve"]);
		} finally {
			process.stderr.write = realErr;
		}
		expect(process.exitCode).toBe(1);
		expect(written.join("")).toBe("dg plugin verify --approve needs a person at a terminal; run it yourself.\n");
		out.length = 0;
		await main(["plugin", "list"]);
		expect(out.join("")).toMatch(/notes\s+skill\s+off\s+unapproved/);
	});

	test("verify without --approve needs no terminal", async () => {
		await main(["plugin", "add", folderSource()]);
		setStdinTTY(false);
		expect(await main(["plugin", "verify", "notes"])).toBe(0);
	});

	test("enabling an unapproved plugin fails with the next step", async () => {
		await main(["plugin", "add", folderSource()]);
		expect(await main(["plugin", "enable", "notes"])).toBe(1);
		expect(err.join("")).toMatch(/dg plugin verify notes --approve/);
	});

	test("the completion tree lists the plugin subcommands", () => {
		const plugin = (skillsTree as { commands: { name: string; commands?: { name: string }[] }[] }).commands.find((node) => node.name === "plugin");
		expect(plugin?.commands?.map((node) => node.name)).toEqual(["list", "add", "remove", "enable", "disable", "update", "verify"]);
	});
});
