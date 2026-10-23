import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSETS = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"plugins",
	"dg",
	"skills",
	"proto",
	"assets",
);

const GOOD_HEADERS = {
	"Content-Type": "application/json",
	"Sec-Fetch-Site": "same-origin",
};

let sandbox: string;
let previousCwd: string;
let handler: { fetch(req: Request): Promise<Response> };

beforeEach(async () => {
	sandbox = mkdtempSync(join(tmpdir(), "dg-endpoint-"));
	mkdirSync(join(sandbox, "project"));
	previousCwd = process.cwd();
	process.chdir(join(sandbox, "project"));
	process.env.DG_SKILLS_BIN = join(sandbox, "missing-binary");
	process.env.NODE_ENV = "development";
	handler = (await import(join(ASSETS, "prototype-endpoint.ts"))).default;
});

afterEach(() => {
	process.chdir(previousCwd);
	rmSync(sandbox, { recursive: true, force: true });
});

function post(body: unknown, headers: Record<string, string> = GOOD_HEADERS) {
	return handler.fetch(
		new Request("http://localhost:3000/prototype-confirm", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
	);
}

const confirm = (name: unknown) => ({
	name,
	variant: "A",
	variants: ["A"],
	action: "confirm",
});

describe("prototype endpoint template", () => {
	test("records a selection for a valid name", async () => {
		const response = await post(confirm("demo-1"));
		expect(response.status).toBe(200);
		expect(
			readFileSync(
				join(sandbox, "project", ".agents", "prototype", "demo-1", ".selection"),
				"utf8",
			),
		).toBe("A\n");
	});

	test.each([
		"../../escaped",
		"..",
		"a/b",
		"/tmp/abs",
		"..%2f..%2fx",
		"",
		undefined,
		7,
	])("rejects the name %p without writing", async (name) => {
		const response = await post({ ...confirm(name), action: "reject" });
		expect(response.status).toBe(400);
		expect(existsSync(join(sandbox, "escaped"))).toBe(false);
		expect(existsSync(join(sandbox, "project", ".agents"))).toBe(false);
	});

	test("rejects a foreign Origin", async () => {
		const response = await post(confirm("demo"), {
			...GOOD_HEADERS,
			Origin: "https://evil.example",
		});
		expect(response.status).toBe(403);
		expect(existsSync(join(sandbox, "project", ".agents"))).toBe(false);
	});

	test("accepts a local Origin on any port", async () => {
		const response = await post(confirm("demo"), {
			...GOOD_HEADERS,
			Origin: "http://localhost:5173",
		});
		expect(response.status).toBe(200);
	});

	test.each(["cross-site", "same-site"])(
		"rejects Sec-Fetch-Site %s",
		async (site) => {
			const response = await post(confirm("demo"), {
				...GOOD_HEADERS,
				"Sec-Fetch-Site": site,
			});
			expect(response.status).toBe(403);
		},
	);

	test("rejects a text/plain body", async () => {
		const response = await post(confirm("demo"), {
			...GOOD_HEADERS,
			"Content-Type": "text/plain",
		});
		expect(response.status).toBe(415);
		expect(existsSync(join(sandbox, "project", ".agents"))).toBe(false);
	});
});

describe("express style handler", () => {
	async function call(body: unknown, headers: Record<string, string>) {
		const mod = await import(join(ASSETS, "prototype-endpoint.ts"));
		let result: { status: number; body: unknown } | undefined;
		await mod.prototypeConfirmHandler(
			{ body, headers },
			{
				status: (status: number) => ({
					json: (value: unknown) => {
						result = { status, body: value };
					},
				}),
			},
		);
		return result;
	}

	test("rejects a traversal name and a foreign origin", async () => {
		const headers = {
			"content-type": "application/json",
			"sec-fetch-site": "same-origin",
		};
		expect((await call(confirm("../../x"), headers))?.status).toBe(400);
		expect(
			(await call(confirm("demo"), { ...headers, origin: "https://evil.example" }))
				?.status,
		).toBe(403);
		expect((await call(confirm("demo"), headers))?.status).toBe(200);
	});
});

describe("framework endpoint templates", () => {
	test.each([
		"prototype-endpoint.next.ts",
		"prototype-endpoint.astro.ts",
	])("%s validates the name and the request origin", (file) => {
		const source = readFileSync(join(ASSETS, file), "utf8");
		expect(source).toContain("/^[a-z0-9][a-z0-9_-]*$/i");
		expect(source).toContain("sec-fetch-site");
		expect(source).toContain("application/json");
		expect(source).toContain("isLocalOrigin");
	});
});
