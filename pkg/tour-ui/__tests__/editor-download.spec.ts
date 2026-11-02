import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { toPlanMarkdown } from "@dg/common";
import { showEditPanel } from "../src/editor";
import {
	clickButton,
	fakeHost,
	installDom,
	restoreDom,
	threeStepScript,
	until,
} from "./fake-host";

beforeEach(() => {
	installDom();
});
afterEach(() => {
	restoreDom();
});

describe("showEditPanel download", () => {
	it("also sends the edited plan through the host", async () => {
		const host = fakeHost();
		const script = threeStepScript();
		void showEditPanel(host, script, {});
		await until(() => host.live().length > 0, "the editor mount");
		clickButton(host, /download plan/i);
		await until(() => host.sent.length > 0, "the download message");
		expect(host.sent[0]).toMatchObject({ kind: "download-plan" });
		expect(String((host.sent[0] as { markdown: string }).markdown)).toContain(
			toPlanMarkdown(script).split("\n")[0] ?? "",
		);
	});
});
