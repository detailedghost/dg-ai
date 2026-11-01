import { describe, expect, test } from "bun:test";
import { assertSafeGetBy } from "../../../src/pw/core/get-by";

const DOLLAR = "$";

describe("assertSafeGetBy", () => {
	test.each([
		'getByRole("button", { name: "Save" })',
		"getByRole('heading', { name: /sign (in|up)/i, level: 2 })",
		`getByText("a (b) [c] ${DOLLAR}{d}", { exact: true }).first()`,
		'getByLabel("Email").nth(-1)',
		'getByTestId("x").filter({ has: page.getByText("y") }).last()',
		'locator("css=div > a").and(page.getByTitle("t"))',
		"getByText(`plain template`)",
	])("accepts %p", (source) => {
		expect(() => assertSafeGetBy(source)).not.toThrow();
	});

	test.each([
		'getByText("x"), process.exit(1)',
		'getByText("x").constructor.constructor("return 1")()',
		'getByText("x")["constructor"]',
		`getByText(\`${DOLLAR}{process.exit(1)}\`)`,
		'getByText("x"); fetch("//evil")',
		"getByText(x = 1)",
		'getByRole("button", { name: (() => 1)() })',
		"getByText(/x/ // c\n)",
		'getByText("unterminated',
		'getByText("x").click()',
		"getByText(globalThis)",
	])("rejects %p", (source) => {
		expect(() => assertSafeGetBy(source)).toThrow(
			"Unsupported locator expression",
		);
	});
});
