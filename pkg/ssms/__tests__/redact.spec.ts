import { describe, expect, test } from "bun:test";
import { sanitizeLogLine } from "../src/privacy/log";
import { redactSecrets } from "../src/privacy/redact";

describe("redactSecrets", () => {
	test("replaces phones, linking URIs, and key material", () => {
		expect(redactSecrets("call +15555550123 now")).toBe("call [phone] now");
		expect(redactSecrets("call +1 (555) 555-0100 now")).toBe("call [phone] now");
		expect(redactSecrets("sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY")).toBe("[link]");
		expect(redactSecrets("pub_key=SECRETKEY")).toBe("pub_key=[redacted]");
		expect(redactSecrets("conversation c1")).toBe("conversation c1");
		expect(redactSecrets("read 5551234567")).toBe("read [phone]");
		expect(redactSecrets("read 555-123-4567")).toBe("read [phone]");
		expect(redactSecrets("read (555) 123-4567")).toBe("read [phone]");
		expect(redactSecrets("read 555 123 4567")).toBe("read [phone]");
		expect(redactSecrets("read 555-123-4567")).not.toContain("555");
	});
});

describe("sanitizeLogLine", () => {
	test("keeps an id and a reason code", () => {
		expect(
			JSON.parse(sanitizeLogLine({ id: "draft-1", reason: "draft", provider: "signal", verb: "draft" })),
		).toEqual({ id: "draft-1", reason: "draft", provider: "signal", verb: "draft" });
	});

	test("drops a secret that was stuffed into the id and replaces the reason", () => {
		const line = JSON.parse(
			sanitizeLogLine({
				id: "sgnl://linkdevice?uuid=abc&pub_key=SECRETKEY",
				reason: "link-uri",
				provider: "signal",
				verb: "link",
			}),
		);
		expect(line.reason).toBe("redacted-secret");
		expect(line.id).toBe("[link]");
		expect(JSON.stringify(line)).not.toContain("sgnl://");
		expect(JSON.stringify(line)).not.toContain("SECRETKEY");
	});

	test("drops a phone stuffed into the id", () => {
		const line = JSON.parse(
			sanitizeLogLine({ id: "+15555550123", reason: "read", provider: "signal", verb: "read" }),
		);
		expect(line).toEqual({
			id: "[phone]",
			reason: "redacted-secret",
			provider: "signal",
			verb: "read",
		});
	});
});
