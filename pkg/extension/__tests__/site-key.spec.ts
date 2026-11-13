import { describe, expect, it } from "bun:test";
import { siteOf } from "@/lib/background/site-key";

describe("siteOf", () => {
	it("groups hosts of one registrable domain", () => {
		expect(siteOf("https://login.live.com/oauth").key).toBe("https://live.com");
		expect(siteOf("https://outlook.live.com/mail/0/").key).toBe("https://live.com");
		expect(siteOf("https://live.com/").key).toBe("https://live.com");
	});

	it("keeps outlook.cloud.microsoft and microsoft.com apart", () => {
		expect(siteOf("https://outlook.cloud.microsoft/mail/").key).toBe("https://cloud.microsoft");
		expect(siteOf("https://www.microsoft.com/").key).toBe("https://microsoft.com");
	});

	it.each([
		["https://a.github.io/", "https://b.github.io/"],
		["https://a.vercel.app/", "https://b.vercel.app/"],
		["https://a.azurewebsites.net/", "https://b.azurewebsites.net/"],
	])("keeps the tenants %s and %s apart", (first, second) => {
		expect(siteOf(first).key).not.toBe(siteOf(second).key);
	});

	it("keeps the scheme in the key", () => {
		expect(siteOf("http://login.live.com/").key).toBe("http://live.com");
		expect(siteOf("http://login.live.com/").key).not.toBe(siteOf("https://login.live.com/").key);
	});

	it.each([
		["http://localhost:3000/a", "http://localhost:3000"],
		["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
		["http://[::1]/", "http://[::1]"],
		["http://intranet/home", "http://intranet"],
		["https://github.io/", "https://github.io"],
		["https://example.com./", "https://example.com."],
		["https://foo.github.io./", "https://foo.github.io."],
		["http://app.localhost./", "http://app.localhost."],
	])("keys %s by its exact host", (url, key) => {
		expect(siteOf(url)).toEqual({ key, name: key.replace(/^https:\/\//, ""), grouped: false });
	});

	it("keeps two local ports apart", () => {
		expect(siteOf("http://localhost:3000/").key).not.toBe(siteOf("http://localhost:8080/").key);
	});

	it("names a grouped site by its domain, with the scheme only for http", () => {
		expect(siteOf("https://login.live.com/")).toEqual({ key: "https://live.com", name: "live.com", grouped: true });
		expect(siteOf("http://login.live.com/")).toEqual({ key: "http://live.com", name: "http://live.com", grouped: true });
	});
});
