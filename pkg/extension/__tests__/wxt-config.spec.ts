import { expect, it } from "bun:test";
import config from "../wxt.config";

type RelevantManifest = {
	host_permissions?: string[];
	permissions?: string[];
	minimum_chrome_version?: string;
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

/**
 * tabCapture.getMediaStreamId() demands the extension be "invoked for the current
 * page", which only activeTab provides. <all_urls> is not a substitute: without
 * activeTab, every record gesture throws "Extension has not been invoked for the
 * current page" and no video is ever captured.
 */
it("declares activeTab wherever tabCapture is available", () => {
	const chromeManifest = manifestFor({ browser: "chrome" });
	expect(chromeManifest.permissions).toContain("activeTab");

	const firefoxManifest = manifestFor({ browser: "firefox" });
	expect(firefoxManifest.permissions).not.toContain("activeTab");
});

/**
 * A service-worker-owned WebSocket (registerChat) needs Chrome 116+; declaring the
 * floor keeps an unsupported browser from silently getting a chat feature that never
 * receives anything instead of an install-time refusal.
 */
it("declares the minimum Chrome version the background WebSocket needs", () => {
	const chromeManifest = manifestFor({ browser: "chrome" });
	expect(chromeManifest.minimum_chrome_version).toBe("116");
});

/**
 * Firefox requires match origins to also be declared in host_permissions — unlike
 * Chrome, where <all_urls> already covers loopback — so the chat marker's own
 * content-script match pattern needs a twin permissions entry on this branch.
 */
it("declares the loopback host permission on the Firefox branch for the chat marker", () => {
	const firefoxManifest = manifestFor({ browser: "firefox" });
	expect(firefoxManifest.host_permissions ?? []).toContain(
		"http://127.0.0.1/*",
	);
});
