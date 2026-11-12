import { expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "../wxt.config";

type RelevantManifest = {
	host_permissions?: string[];
	permissions?: string[];
	minimum_chrome_version?: string;
	side_panel?: { default_path?: string };
	action?: { default_title?: string };
	commands?: Record<string, unknown>;
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
	expect(chromeManifest.permissions).not.toContain("sidePanel");
	expect(chromeManifest.side_panel).toBeUndefined();

	expect(firefoxManifest.host_permissions ?? []).not.toContain("<all_urls>");
	expect(firefoxManifest.permissions).not.toContain("tabCapture");
	expect(firefoxManifest.permissions).not.toContain("offscreen");
	expect(firefoxManifest.permissions).toContain("downloads");
});

it("leaves the toolbar action title to the popup page and keeps the demo recording command", () => {
	const chromeManifest = manifestFor({ browser: "chrome" });
	expect(chromeManifest.action?.default_title).toBeUndefined();
	expect(Object.keys(chromeManifest.commands ?? {})).toContain(
		"start-demo-recording",
	);
});

it("keeps the Firefox manifest free of side panel entries", () => {
	const firefoxManifest = manifestFor({ browser: "firefox" });
	expect(firefoxManifest.side_panel).toBeUndefined();
	expect(firefoxManifest.permissions).not.toContain("sidePanel");
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

it("declares Chrome 118 so planted @scope CSS applies", () => {
	const chromeManifest = manifestFor({ browser: "chrome" });
	expect(chromeManifest.minimum_chrome_version).toBe("118");
});

it("declares the loopback host permission on the Firefox branch for daemon requests", () => {
	const firefoxManifest = manifestFor({ browser: "firefox" });
	expect(firefoxManifest.host_permissions ?? []).toContain(
		"http://127.0.0.1/*",
	);
});

it("declares no content script that matches the loopback daemon origin", () => {
	const entrypoints = resolve(import.meta.dir, "..", "entrypoints");
	const scripts = readdirSync(entrypoints).filter((name) =>
		name.endsWith(".content.ts"),
	);
	expect(scripts.length).toBeGreaterThan(0);
	for (const name of scripts) {
		const source = readFileSync(resolve(entrypoints, name), "utf8");
		const declared = source.match(/matches:\s*\[([^\]]*)\]/)?.[1] ?? "";
		expect(declared, name).not.toMatch(/127\.0\.0\.1|localhost/);
	}
});
