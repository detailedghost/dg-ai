import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeShims } from "../src/install/shims";
import { scratch, type Scratch } from "./runtime-bundle-fixtures";

const TEMPLATE = join(import.meta.dir, "..", "..", "launcher", "shims", "dg.sh");
const NAMES = ["dg-skills", "dg-agent", "dg-daemon"] as const;
const posix = describe.skipIf(process.platform === "win32");

let sandbox: Scratch;

beforeEach(() => {
	sandbox = scratch("write-shims");
});

afterEach(() => {
	sandbox.cleanup();
});

function golden(root: string, name: string): string {
	return readFileSync(TEMPLATE, "utf8").replaceAll("{{ROOT}}", root).replaceAll("{{NAME}}", name);
}

posix("writeShims on a POSIX host", () => {
	test("writes each launcher equal to the golden shim text with the root substituted, mode 0755", () => {
		writeShims(sandbox.root);

		for (const name of NAMES) {
			const path = join(sandbox.root, "bin", name);
			expect(readFileSync(path, "utf8")).toBe(golden(sandbox.root, name));
			expect(statSync(path).mode & 0o777).toBe(0o755);
		}
	});

	test("replaces a compiled binary of the same name with the shim", () => {
		const bin = join(sandbox.root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-daemon"), "compiled ELF bytes", { mode: 0o755 });

		writeShims(sandbox.root);

		expect(readFileSync(join(bin, "dg-daemon"), "utf8")).toBe(golden(sandbox.root, "dg-daemon"));
	});

	test("is idempotent", () => {
		writeShims(sandbox.root);
		writeShims(sandbox.root);

		expect(readFileSync(join(sandbox.root, "bin", "dg-skills"), "utf8")).toBe(
			golden(sandbox.root, "dg-skills"),
		);
	});
});
