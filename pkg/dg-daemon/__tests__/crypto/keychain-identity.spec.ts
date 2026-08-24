import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKENDS = readFileSync(
	join(import.meta.dir, "../../src/crypto/keychain-backends.ts"),
	"utf8",
);

function literal(name: string): string | undefined {
	return new RegExp(`const ${name} = "([^"]+)"`).exec(BACKENDS)?.[1];
}

describe("the keychain lookup identity survives the dg-daemon rename", () => {
	it("still looks the KEK up under the dg-server service, which is where it was stored", () => {
		expect(literal("SERVICE")).toBe("dg-server");
		expect(literal("ACCOUNT")).toBe("chat-store-kek");
	});

	it("uses that one pair everywhere, so lookup and store cannot drift apart", () => {
		const bare = BACKENDS.split("\n")
			.filter((line) => !line.includes("const SERVICE"))
			.filter((line) => !line.includes("const ACCOUNT"))
			.join("\n");

		expect(bare).not.toContain('"chat-store-kek"');
		expect([...bare.matchAll(/"dg-server[^"]*"/g)].map((m) => m[0])).toEqual([
			'"dg-server chat store key"',
		]);
	});
});
