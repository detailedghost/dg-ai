import { expect, test } from "bun:test";
import { shellValue } from "../src/shell";

test("leaves a plain value unquoted", () => {
	expect(shellValue("db/pg1:5432,a=b")).toBe("db/pg1:5432,a=b");
});

test("single-quotes a value with spaces or expansions", () => {
	expect(shellValue("a b")).toBe("'a b'");
	expect(shellValue("$(id)")).toBe("'$(id)'");
});

test("escapes an embedded single quote", () => {
	expect(shellValue("it's")).toBe("'it'\\''s'");
});
