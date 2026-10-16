import { rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { readJsonFile, writeJsonFile } from "../json";

describe("writeJsonFile", () => {
	test("replaces a document without exposing a partial file to readers", async () => {
		const path = `/tmp/email-organizer-json-${crypto.randomUUID()}.json`;
		const marker = "x".repeat(400_000);
		const first = { generation: 1, marker, tail: "one" };
		const second = { generation: 2, marker, tail: "two" };
		await writeJsonFile(path, first);

		let stop = false;
		let torn = 0;
		const seen = new Set<number>();
		const readers = Array.from({ length: 12 }, async () => {
			while (!stop) {
				try {
					const value = await readJsonFile<{
						generation: number;
						marker: string;
						tail: string;
					}>(path);
					const expectedTail =
						value.generation === 1
							? "one"
							: value.generation === 2
								? "two"
								: undefined;
					if (value.marker !== marker || value.tail !== expectedTail) torn += 1;
					else seen.add(value.generation);
				} catch {
					torn += 1;
				}
			}
		});

		for (let index = 0; index < 25; index += 1) {
			await writeJsonFile(path, index % 2 === 0 ? second : first);
		}
		stop = true;
		await Promise.all(readers);
		await rm(path, { force: true });

		expect(torn).toBe(0);
		expect(seen.has(1)).toBe(true);
		expect(seen.has(2)).toBe(true);
	});
});
