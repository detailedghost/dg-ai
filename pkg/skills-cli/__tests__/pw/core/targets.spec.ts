import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { FakePage } from "../../../src/pw/test-support";
import { isRef, locatorCode, RefNotFoundError, resolveTarget, toSelector } from "../../../src/pw/core/targets";

const asPage = (page: FakePage) => page as unknown as Page;

describe("toSelector", () => {
	test("maps a ref to an aria-ref selector", () => {
		expect(toSelector("e12")).toBe("aria-ref=e12");
	});

	test("maps a frame-prefixed ref", () => {
		expect(toSelector("f2e6")).toBe("aria-ref=f2e6");
	});

	test("leaves a CSS selector unchanged", () => {
		expect(toSelector("#main > button")).toBe("#main > button");
	});

	test("does not treat words that start with e as refs", () => {
		expect(isRef("e")).toBe(false);
		expect(isRef("email")).toBe(false);
		expect(isRef("e12x")).toBe(false);
	});
});

describe("resolveTarget", () => {
	test("returns the locator for a known ref", async () => {
		const page = new FakePage();
		const locator = await resolveTarget(asPage(page), "e12");
		expect((locator as unknown as { selector: string }).selector).toBe("aria-ref=e12");
	});

	test("throws the fixed message for a ref that no longer exists", async () => {
		const page = new FakePage();
		page.missing("aria-ref=e9");
		const attempt = resolveTarget(asPage(page), "e9");
		await expect(attempt).rejects.toBeInstanceOf(RefNotFoundError);
		await expect(attempt).rejects.toThrow("Ref not found: e9. Take a new snapshot.");
	});

	test("does not pre-check selectors that are not refs", async () => {
		const page = new FakePage();
		page.missing("#gone");
		const locator = await resolveTarget(asPage(page), "#gone");
		expect((locator as unknown as { selector: string }).selector).toBe("#gone");
	});

	test("evaluates getBy targets against the page", async () => {
		const marker = { count: async () => 1 };
		const page = { getByRole: (role: string) => ({ ...marker, role }) } as unknown as Page;
		const locator = await resolveTarget(page, "getByRole('button')");
		expect((locator as unknown as { role: string }).role).toBe("button");
	});

	test("rejects a getBy target that does not return a locator", async () => {
		const page = { getByRole: () => "nope" } as unknown as Page;
		await expect(resolveTarget(page, "getByRole('button')")).rejects.toThrow("must evaluate to a locator");
	});
});

describe("locatorCode", () => {
	test("prefixes the locator expression with page", async () => {
		const page = new FakePage();
		expect(locatorCode(await resolveTarget(asPage(page), "e1"))).toBe("page.locator('aria-ref=e1')");
	});
});

describe("getBy target safety", () => {
	test("rejects an expression that is not a locator chain before it evaluates", async () => {
		let called = false;
		const page = {
			getByText: () => {
				called = true;
				return {};
			},
		} as unknown as Page;
		await expect(resolveTarget(page, 'getByText("x"), (called = true)')).rejects.toThrow(
			"Unsupported locator expression",
		);
		expect(called).toBe(false);
	});
});
