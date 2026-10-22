import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { statSync, writeFileSync } from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import { useTempScratch } from "../../../src/pw/test-support";
import { attach, levelOf, meetsLevel, safeExtension } from "../../../src/pw/core/events";

class FakeTab extends EventEmitter {
	readonly main = {};

	mainFrame() {
		return this.main;
	}

	readonly request = (navigation: boolean, id: string) =>
		this.emit("request", {
			id,
			isNavigationRequest: () => navigation,
			serviceWorker: () => null,
			frame: () => this.main,
		});

	log(type: string, text: string): void {
		this.emit("console", { type: () => type, text: () => text });
	}
}

const scratch = useTempScratch();

function setup(outputDir = "/tmp") {
	const context = new EventEmitter() as EventEmitter & { pages(): Page[] };
	const existing = new FakeTab();
	context.pages = () => [existing as unknown as Page];
	const events = attach(context as unknown as BrowserContext, outputDir);
	return { context, existing, events, asPage: (tab: FakeTab) => tab as unknown as Page };
}

describe("attach", () => {
	test("buffers console entries per tab and clears them on drain", () => {
		const { existing, events, asPage } = setup();
		existing.log("log", "hello");
		existing.log("error", "bad");
		expect(events.drain(asPage(existing))).toEqual([
			{ type: "log", text: "hello" },
			{ type: "error", text: "bad" },
		]);
		expect(events.drain(asPage(existing))).toEqual([]);
	});

	test("counts errors and warnings, including uncaught page errors", () => {
		const { existing, events, asPage } = setup();
		existing.log("warning", "w");
		existing.log("error", "e");
		existing.emit("pageerror", new Error("thrown"));
		expect(events.totals(asPage(existing))).toEqual({ errors: 2, warnings: 1 });
	});

	test("resets the totals on a main-frame navigation but not on a subframe", () => {
		const { existing, events, asPage } = setup();
		existing.log("error", "e");
		existing.emit("framenavigated", {});
		expect(events.totals(asPage(existing)).errors).toBe(1);
		existing.emit("framenavigated", existing.main);
		expect(events.totals(asPage(existing))).toEqual({ errors: 0, warnings: 0 });
	});

	test("tracks pages opened after attach separately", () => {
		const { context, existing, events, asPage } = setup();
		const popup = new FakeTab();
		context.emit("page", popup);
		popup.log("log", "from popup");
		expect(events.drain(asPage(existing))).toEqual([]);
		expect(events.drain(asPage(popup))).toEqual([{ type: "log", text: "from popup" }]);
	});
});

describe("console levels", () => {
	test("collapses Playwright console types into four levels", () => {
		expect(["log", "dir", "table", "trace", "info"].map(levelOf)).toEqual(["info", "info", "info", "info", "info"]);
		expect([levelOf("error"), levelOf("assert"), levelOf("warning"), levelOf("debug")]).toEqual([
			"error",
			"error",
			"warning",
			"debug",
		]);
	});

	test("a level includes the more severe ones", () => {
		const types = ["error", "warning", "log", "debug"];
		const shown = (min: "error" | "warning" | "info" | "debug") =>
			types.filter((type) => meetsLevel({ type, text: "" }, min));
		expect(shown("warning")).toEqual(["error", "warning"]);
		expect(shown("info")).toEqual(["error", "warning", "log"]);
		expect(shown("debug")).toEqual(types);
	});
});

describe("retained buffers", () => {
	test("console keeps entries after a drain and clears on request", () => {
		const { existing, events, asPage } = setup();
		existing.log("log", "a");
		events.drain(asPage(existing));
		expect(events.console(asPage(existing))).toEqual([{ type: "log", text: "a" }]);
		events.clearConsole(asPage(existing));
		expect(events.console(asPage(existing))).toEqual([]);
		expect(events.totals(asPage(existing))).toEqual({ errors: 0, warnings: 0 });
	});

	test("a main-frame navigation clears the retained console", () => {
		const { existing, events, asPage } = setup();
		existing.log("log", "old");
		existing.emit("framenavigated", existing.main);
		expect(events.console(asPage(existing))).toEqual([]);
	});

	test("a navigation request starts a fresh request list", () => {
		const { existing, events, asPage } = setup();
		existing.request(false, "a");
		existing.request(true, "page");
		existing.request(false, "b");
		expect(events.requests(asPage(existing)).map((request) => (request as unknown as { id: string }).id)).toEqual([
			"page",
			"b",
		]);
		events.clearRequests(asPage(existing));
		expect(events.requests(asPage(existing))).toEqual([]);
	});
});

describe("modal state", () => {
	const dialog = { type: () => "confirm", message: () => "Delete?\nsecond line" };

	test("stashes a dialog and lists it with the commands that handle it", () => {
		const { existing, events, asPage } = setup();
		existing.emit("dialog", dialog);
		expect(events.hasDialog(asPage(existing))).toBe(true);
		expect(events.modal(asPage(existing))).toEqual([
			'- ["confirm" dialog with message "Delete?"]: can be handled by the "dialog-accept" or "dialog-dismiss" command',
		]);
		expect(events.takeDialog(asPage(existing))).toBe(dialog as never);
		expect(events.modal(asPage(existing))).toEqual([]);
	});

	test("stashes a file chooser until it is taken", () => {
		const { existing, events, asPage } = setup();
		const chooser = {};
		existing.emit("filechooser", chooser);
		expect(events.hasChooser(asPage(existing))).toBe(true);
		expect(events.modal(asPage(existing))).toEqual(['- [File chooser]: can be handled by the "upload" command']);
		expect(events.takeChooser(asPage(existing))).toBe(chooser as never);
		expect(events.hasChooser(asPage(existing))).toBe(false);
	});

	test("watchDialog resolves when a dialog opens, and at once when one is already pending", async () => {
		const { existing, events, asPage } = setup();
		const watch = events.watchDialog(asPage(existing));
		let opened = false;
		void watch.opened.then(() => {
			opened = true;
		});
		await Promise.resolve();
		expect(opened).toBe(false);
		existing.emit("dialog", dialog);
		await watch.opened;
		watch.dispose();
		await events.watchDialog(asPage(existing)).opened;
	});
});

describe("downloads", () => {
	test("saves a download to the output directory and reports it once", async () => {
		const { existing, events, asPage } = setup(scratch.dir);
		const saved: string[] = [];
		existing.emit("download", {
			suggestedFilename: () => "report.csv",
			saveAs: async (file: string) => {
				saved.push(file);
				writeFileSync(file, "a,b");
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(saved[0]).toStartWith(`${scratch.dir}/download-`);
		expect(statSync(saved[0] as string).mode & 0o777).toBe(0o600);
		expect(events.drainNotices(asPage(existing))).toEqual([`- Downloaded report.csv to ${saved[0]}`]);
		expect(events.drainNotices(asPage(existing))).toEqual([]);
	});

	test("reports a failed download without throwing", async () => {
		const { existing, events, asPage } = setup();
		existing.emit("download", {
			suggestedFilename: () => "x.bin",
			saveAs: async () => {
				throw new Error("disk full");
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(events.drainNotices(asPage(existing))).toEqual(["- Download of x.bin failed: disk full"]);
	});
});

describe("safeExtension", () => {
	test("keeps a plain extension and falls back to bin for anything else", () => {
		expect(safeExtension("report.csv")).toBe("csv");
		expect(safeExtension("noext")).toBe("bin");
		expect(safeExtension("x.a/b")).toBe("bin");
		expect(safeExtension("x.toolongextension")).toBe("bin");
		expect(safeExtension("x.")).toBe("bin");
	});
});
