import { describe, expect, test } from "bun:test";
import type { InboxBrowserRequest, InboxBrowserResponse } from "@dg/common";
import { defaultConfig } from "../../config/defaults";
import { ProtonGate, type Clock } from "../../features/filter-policy/jitter";
import { bindInboxRuntime } from "../../runtime";
import { createProtonMailClient } from "../client";

const clock: Clock = { now: () => 0, sleep: async () => {} };

function world(ext: boolean | undefined) {
	const config = {
		...defaultConfig,
		provider: "protonmail" as const,
		protonmail: { ...defaultConfig.protonmail, dataPath: undefined },
	};
	const pw: InboxBrowserRequest[] = [];
	const extension: InboxBrowserRequest[] = [];
	const answer: InboxBrowserResponse = {
		folders: [{ id: "0", name: "Inbox", type: "system" }],
	};
	bindInboxRuntime(
		config,
		{
			...(ext === undefined ? {} : { ext }),
			protonGate: new ProtonGate(clock, () => 0.1, 5),
			pwBrowserRequest: async (request) => {
				pw.push(request);
				return answer;
			},
			browserRequest: async (request) => {
				extension.push(request);
				return answer;
			},
		},
		"default",
	);
	return { client: createProtonMailClient(config), pw, extension };
}

describe("client createProtonMailClient transport selection", () => {
	test("without ext the Proton provider uses the pw transport", async () => {
		const { client, pw, extension } = world(undefined);
		await client.listFolders();
		expect(pw.map((request) => request.operation)).toEqual(["list-folders"]);
		expect(extension).toHaveLength(0);
	});

	test("with ext false the Proton provider still uses the pw transport", async () => {
		const { client, pw, extension } = world(false);
		await client.listFolders();
		expect(pw).toHaveLength(1);
		expect(extension).toHaveLength(0);
	});

	test("with ext the Proton provider uses the extension transport", async () => {
		const { client, pw, extension } = world(true);
		await client.listFolders();
		expect(extension.map((request) => request.operation)).toEqual([
			"list-folders",
		]);
		expect(pw).toHaveLength(0);
	});
});
