import { describe, expect, it } from "bun:test";
import { isPhiSite, isSiteKey } from "../src/phi-sites";

describe("isSiteKey", () => {
	it.each(["https://example.org", "http://localhost:8080", "https://a.b.example.org", "http://[::1]:3000"])("accepts %s", (key) => {
		expect(isSiteKey(key)).toBe(true);
	});

	it.each(["example.org", "https://Example.org", "https://example.org/path", "ftp://example.org", "", "https://", "https://:", "http://[", "https://example.org:443", "https://a b"])("rejects %p", (key) => {
		expect(isSiteKey(key)).toBe(false);
	});
});

describe("isPhiSite", () => {
	const sites = ["https://ehr.example.org", "http://localhost:8080"];

	it("matches the site and its subdomains on the same scheme", () => {
		expect(isPhiSite("https://ehr.example.org/chart/1", sites)).toBe(true);
		expect(isPhiSite("https://app.ehr.example.org/", sites)).toBe(true);
	});

	it("keeps other sites, schemes and look-alike hosts out", () => {
		expect(isPhiSite("https://example.org/", sites)).toBe(false);
		expect(isPhiSite("http://ehr.example.org/", sites)).toBe(false);
		expect(isPhiSite("https://notehr.example.org/", sites)).toBe(false);
		expect(isPhiSite("https://ehr.example.org.evil.test/", sites)).toBe(false);
	});

	it("matches a non-default port exactly", () => {
		expect(isPhiSite("http://localhost:8080/x", sites)).toBe(true);
		expect(isPhiSite("http://localhost:9090/x", sites)).toBe(false);
		expect(isPhiSite("http://localhost/x", sites)).toBe(false);
	});

	it("is false for an empty list and for a url that does not parse", () => {
		expect(isPhiSite("https://ehr.example.org/", [])).toBe(false);
		expect(isPhiSite("not a url", sites)).toBe(false);
	});

	it("answers instead of throwing when a listed key does not parse", () => {
		expect(isPhiSite("https://ehr.example.org/", ["https://:"])).toBe(false);
	});
});
