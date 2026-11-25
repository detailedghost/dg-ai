import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "../src/errors";
import { pluginTokenCredential, ROUTES, type Route } from "../src/plugins/contract";
import { parseManifest, type PluginManifest } from "../src/plugins/manifest";
import { httpTransport, PluginTransportError } from "../src/plugins/transport/http";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "plugins");
const TOKEN = "tok-secret-1234567890";

type Fixture = { route: string; direction: "request" | "response"; body: Record<string, unknown> };

function fixture(name: string): Fixture {
	return JSON.parse(readFileSync(join(FIXTURES, "messages", "valid", name), "utf8")) as Fixture;
}

function manifestFor(endpoint: string, extra = ""): PluginManifest {
	return parseManifest(
		`name = "local-hook"\nversion = "1.0.0"\nkind = "hook"\ntransport = "http"\nendpoint = "${endpoint}"\n${extra}\n[entry]\ncommand = "local-hook"\n`,
		"plugin.toml",
	);
}

function credentials(value: string | null = TOKEN) {
	const asked: string[] = [];
	return {
		asked,
		resolveCredential: async (name: string) => {
			asked.push(name);
			return value === null ? undefined : { value, source: "store" as const };
		},
	};
}

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (request: Request, url: URL) => Response | Promise<Response>) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request, new URL(request.url)) });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function caught(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(error: unknown) => error,
	);
}

describe("httpTransport fixtures", () => {
	test("round-trips every valid request and response fixture", async () => {
		const files = readdirSync(join(FIXTURES, "messages", "valid"));
		const responses = new Map(files.filter((f) => f.endsWith("-response.json")).map((f) => [fixture(f).route, fixture(f).body]));
		const seen: Array<{ path: string; method: string; auth: string | null; type: string | null; body: unknown }> = [];
		const endpoint = serve(async (request, url) => {
			seen.push({
				path: url.pathname,
				method: request.method,
				auth: request.headers.get("authorization"),
				type: request.headers.get("content-type"),
				body: await request.json(),
			});
			return Response.json(responses.get(url.pathname));
		});
		const transport = httpTransport(manifestFor(endpoint), { credentials: credentials() });
		const requests = files.filter((f) => f.endsWith("-request.json")).map(fixture);
		expect(requests.length).toBe(ROUTES.length);
		for (const message of requests) {
			const result = await transport.request({ route: message.route as Route, body: message.body });
			expect(result.body).toEqual(responses.get(message.route) as Record<string, unknown>);
		}
		expect(seen.map((s) => s.path).sort()).toEqual([...ROUTES].sort());
		for (const entry of seen) {
			expect(entry.method).toBe("POST");
			expect(entry.auth).toBe(`Bearer ${TOKEN}`);
			expect(entry.type).toContain("application/json");
		}
		expect(seen.find((s) => s.path === "/v1/hook/decide")?.body).toEqual(fixture("hook-decide-request.json").body);
	});

	test("resolves the token from the plugin credential name", async () => {
		const endpoint = serve(() => Response.json(fixture("health-response.json").body));
		const creds = credentials();
		await httpTransport(manifestFor(endpoint), { credentials: creds }).request({ route: "/v1/health", body: {} });
		expect(creds.asked).toEqual([pluginTokenCredential("local-hook")]);
	});

	test("keeps the base path of the endpoint", async () => {
		let path = "";
		const endpoint = serve((_, url) => {
			path = url.pathname;
			return Response.json(fixture("health-response.json").body);
		});
		await httpTransport(manifestFor(`${endpoint}/dg`), { credentials: credentials() }).request({ route: "/v1/health", body: {} });
		expect(path).toBe("/dg/v1/health");
	});
});

describe("httpTransport errors", () => {
	test("rejects an invalid request body before it sends", async () => {
		let hits = 0;
		const endpoint = serve(() => {
			hits += 1;
			return Response.json({});
		});
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/hook/decide", body: {} }));
		expect(error).toBeInstanceOf(DgCliError);
		expect(String((error as Error).message)).toContain("body.event");
		expect(hits).toBe(0);
	});

	test("rejects a response that breaks the contract", async () => {
		const endpoint = serve(() => Response.json({ decision: "maybe" }));
		const error = await caught(
			httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/hook/decide", body: fixture("hook-decide-request.json").body }),
		);
		expect(String((error as Error).message)).toContain("body.decision");
	});

	test("raises a timeout error when the plugin is slow", async () => {
		const endpoint = serve(async () => {
			await Bun.sleep(300);
			return Response.json(fixture("health-response.json").body);
		});
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/health", body: {} }, { timeoutMs: 50 }));
		expect(error).toBeInstanceOf(PluginTransportError);
		expect((error as PluginTransportError).code).toBe("timeout");
	});

	test.each([401, 403])("raises an auth error on status %i and hides the token", async (status) => {
		const endpoint = serve(() => Response.json({ code: "unauthorized", message: `bad token ${TOKEN}` }, { status }));
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/health", body: {} }));
		expect((error as PluginTransportError).code).toBe("auth");
		expect(String((error as Error).message)).not.toContain(TOKEN);
	});

	test("raises an auth error and names the credential when no token is stored", async () => {
		let hits = 0;
		const endpoint = serve(() => {
			hits += 1;
			return Response.json({});
		});
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials(null) }).request({ route: "/v1/health", body: {} }));
		expect((error as PluginTransportError).code).toBe("auth");
		expect((error as Error).message).toContain("plugin-local-hook-token");
		expect(hits).toBe(0);
	});

	test("redacts the token from a plugin error message", async () => {
		const endpoint = serve(() => Response.json({ code: "boom", message: `failed with ${TOKEN}` }, { status: 500 }));
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/health", body: {} }));
		expect((error as PluginTransportError).code).toBe("plugin");
		expect((error as Error).message).toContain("boom");
		expect((error as Error).message).not.toContain(TOKEN);
	});

	test("raises an unreachable error without the token when the port is closed", async () => {
		const endpoint = serve(() => Response.json({}));
		servers.pop()?.stop(true);
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/health", body: {} }));
		expect((error as PluginTransportError).code).toBe("unreachable");
		expect((error as Error).message).not.toContain(TOKEN);
	});

	test("refuses a response over the size limit", async () => {
		const endpoint = serve(() => new Response(JSON.stringify({ status: "ok", version: "x".repeat(1_100_000) })));
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/health", body: {} }));
		expect((error as PluginTransportError).code).toBe("oversize");
	});

	test("refuses a request over the size limit", async () => {
		const endpoint = serve(() => Response.json({}));
		const error = await caught(
			httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/hook/decide", body: { event: "x".repeat(1_100_000) } }),
		);
		expect((error as PluginTransportError).code).toBe("oversize");
	});

	test("does not follow a redirect with the token", async () => {
		let leaked: string | null = "unset";
		const target = serve((request) => {
			leaked = request.headers.get("authorization");
			return Response.json(fixture("health-response.json").body);
		});
		const endpoint = serve(() => Response.redirect(`${target}/v1/health`, 307));
		const error = await caught(httpTransport(manifestFor(endpoint), { credentials: credentials() }).request({ route: "/v1/health", body: {} }));
		expect(error).toBeInstanceOf(PluginTransportError);
		expect(leaked).toBe("unset");
	});
});

describe("httpTransport remote policy", () => {
	const remote = (): PluginManifest => parseManifest(readFileSync(join(FIXTURES, "manifests", "valid", "remote-hook-http.toml"), "utf8"), "plugin.toml");

	test("refuses a remote manifest unless allowRemote is true", () => {
		const error = (() => {
			try {
				httpTransport(remote(), { credentials: credentials() });
			} catch (thrown) {
				return thrown;
			}
		})();
		expect(error).toBeInstanceOf(PluginTransportError);
		expect((error as PluginTransportError).code).toBe("refused");
		expect((error as Error).message).toContain("allow_remote");
	});

	test("accepts a remote https manifest when allowRemote is true", () => {
		expect(() => httpTransport(remote(), { credentials: credentials(), allowRemote: true })).not.toThrow();
	});

	test("refuses a non-loopback endpoint on a manifest that is not remote", () => {
		const manifest = { ...manifestFor("http://127.0.0.1:9"), endpoint: "https://policy.example.com/dg" };
		expect(() => httpTransport(manifest, { credentials: credentials(), allowRemote: true })).toThrow(/loopback/);
	});

	test("names the credentials command when the endpoint holds a user name", () => {
		const manifest = { ...manifestFor("http://127.0.0.1:9"), endpoint: "http://user:pw@127.0.0.1:9/dg" };
		expect(() => httpTransport(manifest, { credentials: credentials() })).toThrow(
			/Next: remove the credentials from endpoint in plugin\.toml, then run dg credentials set plugin-/,
		);
	});

	test("names the remote setting when a non-loopback endpoint is not remote", () => {
		const manifest = { ...manifestFor("http://127.0.0.1:9"), endpoint: "https://policy.example.com/dg" };
		expect(() => httpTransport(manifest, { credentials: credentials(), allowRemote: true })).toThrow(
			/Next: set remote = true in plugin\.toml and allow_remote = true in config\.toml, or use a loopback endpoint/,
		);
	});

	test("refuses a remote endpoint that is not https", () => {
		const manifest = { ...remote(), endpoint: "http://policy.example.com/dg" };
		expect(() => httpTransport(manifest, { credentials: credentials(), allowRemote: true })).toThrow(/Next: use an https endpoint in plugin\.toml/);
	});

	test("names the http scheme when the endpoint is not an http URL", () => {
		const manifest = { ...manifestFor("http://127.0.0.1:9"), endpoint: "ftp://127.0.0.1:9/dg" };
		expect(() => httpTransport(manifest, { credentials: credentials() })).toThrow(
			/Next: set endpoint to an http or https URL in plugin\.toml/,
		);
	});

	test("refuses a manifest that does not use the http transport", () => {
		const manifest = { ...manifestFor("http://127.0.0.1:9"), transport: "tcp" as const };
		expect(() => httpTransport(manifest, { credentials: credentials() })).toThrow(/http transport/);
	});

	test("refuses an endpoint URL that carries credentials without echoing them", () => {
		const manifest = { ...manifestFor("http://127.0.0.1:9"), endpoint: `http://user:${TOKEN}@127.0.0.1:9` };
		const error = (() => {
			try {
				httpTransport(manifest, { credentials: credentials() });
			} catch (thrown) {
				return thrown as Error;
			}
		})();
		expect(error?.message).toBeDefined();
		expect(error?.message).not.toContain(TOKEN);
	});
});
