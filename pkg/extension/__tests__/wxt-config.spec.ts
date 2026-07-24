import { expect, it } from "bun:test";
import config from "../wxt.config";

type RelevantManifest = {
	host_permissions?: string[];
	permissions?: string[];
};

const manifestFor = config.manifest as unknown as (environment: {
	browser: "chrome" | "firefox";
}) => RelevantManifest;

it("grants capture host access without dropping browser-specific permissions", () => {
	const chromeManifest = manifestFor({ browser: "chrome" });
	const firefoxManifest = manifestFor({ browser: "firefox" });

	expect(chromeManifest.host_permissions).toContain("<all_urls>");
	expect(chromeManifest.host_permissions).toContain("https://huggingface.co/*");
	expect(chromeManifest.host_permissions).toContain(
		"https://cdn.jsdelivr.net/*",
	);
	expect(chromeManifest.permissions).toContain("tabCapture");
	expect(chromeManifest.permissions).toContain("offscreen");
	expect(chromeManifest.permissions).toContain("downloads");

	expect(firefoxManifest.host_permissions ?? []).not.toContain("<all_urls>");
	expect(firefoxManifest.permissions).not.toContain("tabCapture");
	expect(firefoxManifest.permissions).not.toContain("offscreen");
	expect(firefoxManifest.permissions).toContain("downloads");
});
