import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtoExtensionInstalled } from "../src/utils/proto-detect";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "dg-proto-detect-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("isProtoExtensionInstalled", () => {
	test("reports installation only when the marker path is a file", async () => {
		const directory = await temporaryDirectory();
		const marker = join(directory, "browser-batch-installed");

		expect(isProtoExtensionInstalled(marker)).toBe(false);
		await writeFile(marker, '{"chrome":"1.0.0"}\n');
		expect(isProtoExtensionInstalled(marker)).toBe(true);
		await rm(marker);
		await mkdir(marker);
		expect(isProtoExtensionInstalled(marker)).toBe(false);
	});
});
