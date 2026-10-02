import type { InboxBrowserRequest } from "@dg/common";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A separate process isolates the non-configurable API installed by the real MAIN entrypoint.
const payload = JSON.parse(await Bun.stdin.text()) as {
	func: string;
	request: InboxBrowserRequest;
	install: boolean;
	pageUrl?: string;
};
const calls: string[] = [];
const location = new URL(payload.pageUrl ?? "https://mail.proton.me/u/0/inbox");
class PageXhr {
	open() {}
	setRequestHeader() {}
	send() {}
}
const page = {
	location,
	XMLHttpRequest: PageXhr,
	fetch: async (url: RequestInfo | URL, _init?: RequestInit) => {
		calls.push(String(url));
		return new Response(JSON.stringify({ Code: 1000, Total: 1, Messages: [{
			ID: "serialized-main-message", Sender: { Address: "person@example.test" },
			Subject: "Private person@example.test", Body: "secret-body", LabelIDs: ["0"],
		}] }));
	},
};
Object.assign(globalThis, {
	window: page,
	location,
	defineContentScript: (definition: unknown) => definition,
});
if (payload.install) {
	const build = await Bun.build({
		entrypoints: [new URL("../../entrypoints/inbox-proton-main.content.ts", import.meta.url).pathname],
		target: "browser",
		format: "esm",
	});
	if (!build.success) throw new Error(build.logs.map(String).join("\n"));
	const source = await build.outputs[0]!.text();
	const directory = mkdtempSync(join(tmpdir(), "dg-proton-main-"));
	try {
		const filename = join(directory, "main.mjs");
		await Bun.write(filename, source);
		const installed = await import(pathToFileURL(filename).href);
		(installed.default as { main(): void }).main();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	await page.fetch("/api/mail/v4/messages", { headers: {
		"x-pm-uid": "page-memory-secret", "x-pm-appversion": "web-mail@5",
	} });
	calls.length = 0;
}
const execute = Function(`return (${payload.func})`)() as (request: InboxBrowserRequest) => Promise<unknown>;
process.stdout.write(JSON.stringify({ result: await execute(payload.request), calls }));
