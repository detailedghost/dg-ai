import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir } from "../src/node/fs";

describe("ensurePrivateDir", () => {
	it("repairs permissions on an existing directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-private-dir-"));
		try {
			chmodSync(directory, 0o777);

			ensurePrivateDir(directory);

			expect(statSync(directory).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});
