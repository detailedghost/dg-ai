import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { sentinelPaths } from "../src/prototype/paths";
import {
	injectIntoHtml,
	startServer,
	type RunningServer,
} from "../src/prototype/serve";
import { makeTempDir } from "./git-repo-fixtures";

const TOOLS = [
	{ name: "get_prototype_state" },
	{ name: "list_prototype_variants" },
];

let root: string;
let server: RunningServer | undefined;

const basePort = () => 41000 + Math.floor(Math.random() * 2000);

beforeEach(() => {
	root = makeTempDir("dg-prototype-serve-");
});

afterEach(() => {
	server?.stop();
	server = undefined;
	rmSync(root, { recursive: true, force: true });
});

async function serve(options: { idleSec?: number; onIdle?: () => void } = {}) {
	const htmlFile = join(root, "page.html");
	writeFileSync(
		htmlFile,
		"<html><head><title>t</title></head><body><p>hello</p></body></html>",
	);
	const paths = sentinelPaths(join(root, "sentinels"));
	server = await startServer({
		htmlFile,
		name: "demo",
		paths,
		port: basePort(),
		tools: TOOLS,
		...options,
	});
	const url = `http://127.0.0.1:${server.port}`;
	const post = (body: unknown) =>
		fetch(`${url}/prototype-decision`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	return { url, paths, post };
}

describe("prototype serve", () => {
	test("injects the decision client, favicon, and WebMCP tools into the page", async () => {
		const { url } = await serve();
		const html = await (await fetch(url)).text();
		expect(html).toContain('<link rel="icon"');
		expect(html).toContain("window.prototypeDecide");
		expect(html).toContain('"get_prototype_state"');
		expect(html.indexOf("window.prototypeDecide")).toBeLessThan(
			html.indexOf("</body>"),
		);
	});

	test("appends the client when the page has no body or head", () => {
		const page = injectIntoHtml("<p>x</p>", "demo", TOOLS);
		expect(page.startsWith("<p>x</p>")).toBe(true);
		expect(page).toContain("prototypePlanDecision");
	});

	test("a confirm writes the notes and then the selection sentinel", async () => {
		const { post, paths } = await serve();
		const response = await post({
			action: "confirm",
			variant: "B",
			notes: "keep it",
		});
		expect(await response.json()).toEqual({ ok: true });
		expect(readFileSync(paths.selection, "utf8")).toBe("B\n");
		expect(readFileSync(paths.notes, "utf8")).toBe("keep it");
	});

	test("a reject writes the notes, or a bare newline when there are none", async () => {
		const { post, paths } = await serve();
		await post({ action: "reject", notes: "no" });
		expect(readFileSync(paths.reject, "utf8")).toBe("no");
		await post({ action: "reject" });
		expect(readFileSync(paths.reject, "utf8")).toBe("\n");
	});

	test("a plan decision is normalized and stored", async () => {
		const { post, paths } = await serve();
		await post({ decision: "rework", notes: "reorder" });
		expect(JSON.parse(readFileSync(paths.decision, "utf8"))).toEqual({
			decision: "REWORK",
			notes: "reorder",
		});
	});

	test.each([
		[{ decision: "maybe" }, "decision must be"],
		[{ action: "drop" }, "action must be"],
		[{ action: "confirm" }, "variant is required"],
		[
			{ action: "confirm", variant: "Z", variants: ["A"] },
			"not in allowed list",
		],
	])("rejects the invalid decision %j", async (body, message) => {
		const { post, paths } = await serve();
		const response = await post(body);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(
			message,
		);
		expect(existsSync(paths.selection)).toBe(false);
	});

	test("rejects a malformed body and non-object JSON", async () => {
		const { url } = await serve();
		for (const body of ["{", "[]", "null"]) {
			const response = await fetch(`${url}/prototype-decision`, {
				method: "POST",
				body,
			});
			expect(response.status).toBe(400);
		}
		expect((await fetch(`${url}/x`, { method: "PUT" })).status).toBe(405);
	});

	test("reports decision state without consuming it", async () => {
		const { url, post, paths } = await serve();
		const state = async () =>
			(
				(await (await fetch(`${url}/prototype-state`)).json()) as {
					status: string;
				}
			).status;
		expect(await state()).toBe("pending");
		await post({ decision: "APPROVED" });
		expect(await state()).toBe("approved");
		rmSync(paths.decision);
		await post({ action: "reject", notes: "x" });
		expect(await state()).toBe("rejected");
		rmSync(paths.reject);
		await post({ action: "confirm", variant: "A" });
		expect(await state()).toBe("approved");
		expect(existsSync(paths.selection)).toBe(true);
	});

	test("serves the reload token and the changes manifest, ignoring a malformed one", async () => {
		const { url, paths } = await serve();
		expect(await (await fetch(`${url}/prototype-reload`)).json()).toEqual({
			token: "0",
		});
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.reload, "123\n");
		expect(await (await fetch(`${url}/prototype-reload`)).json()).toEqual({
			token: "123",
		});
		expect(await (await fetch(`${url}/prototype-changes`)).json()).toEqual({});
		writeFileSync(paths.changes, '{"rev":"123","screens":[{"id":"list"}]}');
		expect(
			(
				(await (await fetch(`${url}/prototype-changes`)).json()) as {
					rev: string;
				}
			).rev,
		).toBe("123");
		writeFileSync(paths.changes, "{");
		expect(await (await fetch(`${url}/prototype-changes`)).json()).toEqual({});
	});

	test("refuses a request whose Host header is not local", async () => {
		const { url } = await serve();
		const port = Number(new URL(url).port);
		const reply = await new Promise<string>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port }, () =>
				socket.write(
					"GET / HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
				),
			);
			let data = "";
			socket.on("data", (chunk) => {
				data += chunk;
			});
			socket.on("end", () => resolve(data));
			socket.on("error", reject);
		});
		expect(reply.split("\r\n")[0]).toContain("403");
	});

	test("skips an occupied port and tears the server down on stop", async () => {
		const first = await serve();
		const second = await startServer({
			htmlFile: join(root, "page.html"),
			name: "demo",
			paths: first.paths,
			port: server?.port,
			tools: TOOLS,
		});
		expect(second.port).toBeGreaterThan(server?.port ?? 0);
		second.stop();
		await expect(
			fetch(`http://127.0.0.1:${second.port}/prototype-state`),
		).rejects.toThrow();
		server?.stop();
		await expect(fetch(`${first.url}/prototype-state`)).rejects.toThrow();
	});

	test("stops itself after the idle window and reports it", async () => {
		let idle = false;
		const { url } = await serve({
			idleSec: 1,
			onIdle: () => void (idle = true),
		});
		await Bun.sleep(2600);
		expect(idle).toBe(true);
		await expect(fetch(`${url}/prototype-state`)).rejects.toThrow();
	});
});
