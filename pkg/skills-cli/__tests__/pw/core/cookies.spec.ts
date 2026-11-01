import { describe, expect, test } from "bun:test";
import type { Cookie } from "playwright-core";
import { formatCookie, formatCookieDetail } from "../../../src/pw/core/cookies";

const cookie: Cookie = {
	name: "sid",
	value: "1",
	domain: "a.test",
	path: "/",
	httpOnly: true,
	secure: false,
	sameSite: "Lax",
	expires: -1,
};

describe("cookie formatting", () => {
	test("short form names the cookie, domain, and path", () => {
		expect(formatCookie(cookie)).toBe("sid=1 (domain: a.test, path: /)");
	});

	test("detail form adds flags and expiry", () => {
		expect(formatCookieDetail(cookie)).toBe(
			"sid=1 (domain: a.test, path: /, httpOnly: true, secure: false, sameSite: Lax, expires: -1)",
		);
	});
});
