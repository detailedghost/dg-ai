import { afterEach, describe, expect, test } from "bun:test";
import {
	SECRET_CODE_HEADER,
	SECRET_INTAKE_PATH,
} from "@dg/common";
import { Window } from "happy-dom";
import { renderSecretPage } from "../src/secret/main";

const PORT = 47823;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CODE = "fixture-code-AbC_123-xyz";
const VALUE = "fixture-typed-password-9c41e7";
const windows: Window[] = [];

afterEach(async () => {
	await Promise.all(windows.splice(0).map((win) => win.happyDOM.close()));
});

type Call = { url: string; init: RequestInit };

function open(
	href: string,
	respond: (call: Call) => Response | Promise<Response> = ({ init }) =>
		init.method === "POST"
			? new Response(null, { status: 204 })
			: Response.json({ name: "db/pg1" }),
) {
	const win = new Window({ url: href });
	windows.push(win);
	const app = win.document.createElement("div");
	app.id = "app";
	win.document.body.append(app);
	const calls: Call[] = [];
	const fetchFn = (async (url: string, init: RequestInit = {}) => {
		const call = { url, init };
		calls.push(call);
		return respond(call);
	}) as unknown as typeof fetch;
	return { win, calls, fetchFn, document: win.document };
}

async function render(page: ReturnType<typeof open>): Promise<void> {
	await renderSecretPage(page.win as unknown as globalThis.Window, page.fetchFn);
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

function type(page: ReturnType<typeof open>, value: string): HTMLInputElement {
	const input = page.document.querySelector("input") as unknown as HTMLInputElement;
	input.value = value;
	return input;
}

async function submit(page: ReturnType<typeof open>): Promise<void> {
	const form = page.document.querySelector("form");
	form?.dispatchEvent(new page.win.Event("submit", { cancelable: true }));
	await settle();
}

function text(page: ReturnType<typeof open>): string {
	return page.document.body.textContent ?? "";
}

const URL_WITH_CODE = `${ORIGIN}/secret#code=${CODE}`;

describe("secret page", () => {
	test("reads the code from the fragment, strips it from the address and asks for the name with it", async () => {
		const page = open(URL_WITH_CODE);

		await render(page);

		expect(page.win.location.href).toBe(`${ORIGIN}/secret`);
		expect(page.win.location.href).not.toContain(CODE);
		expect(page.calls).toHaveLength(1);
		expect(page.calls[0]?.url).toBe(`${ORIGIN}${SECRET_INTAKE_PATH}`);
		expect(page.calls[0]?.init.method ?? "GET").toBe("GET");
		expect(page.calls[0]?.init.headers).toEqual({ [SECRET_CODE_HEADER]: CODE });
	});

	test("shows the credential name and exactly one labeled password field", async () => {
		const page = open(URL_WITH_CODE);

		await render(page);

		expect(text(page)).toContain("db/pg1");
		const inputs = [...page.document.querySelectorAll("input")];
		expect(inputs).toHaveLength(1);
		const input = inputs[0] as unknown as HTMLInputElement;
		expect(input.type).toBe("password");
		expect(input.getAttribute("autocomplete")).toBe("off");
		expect(input.labels?.[0]?.textContent?.trim()).toBeTruthy();
		expect(page.document.querySelectorAll("button")).toHaveLength(1);
	});

	test("shows only the name even when the reply carries more", async () => {
		const page = open(URL_WITH_CODE, () =>
			Response.json({
				name: "db/pg1",
				meta: { host: "10.9.8.7" },
				token: "fixture-session-token",
			}),
		);

		await render(page);

		expect(text(page)).not.toContain("10.9.8.7");
		expect(text(page)).not.toContain("fixture-session-token");
	});

	test("renders the name as text, never as markup", async () => {
		const page = open(URL_WITH_CODE, () => Response.json({ name: "<b>db</b>" }));

		await render(page);

		expect(text(page)).toContain("<b>db</b>");
		expect(page.document.querySelector("b")).toBeNull();
	});

	test("sends the code and the typed value to the daemon, clears the field and confirms", async () => {
		const page = open(URL_WITH_CODE);
		await render(page);
		const input = type(page, VALUE);

		await submit(page);

		const post = page.calls.find((call) => call.init.method === "POST");
		expect(post?.url).toBe(`${ORIGIN}${SECRET_INTAKE_PATH}`);
		expect(JSON.parse(String(post?.init.body))).toEqual({ code: CODE, value: VALUE });
		expect(input.value).toBe("");
		expect(text(page)).toContain("Saved");
		expect(text(page)).not.toContain(VALUE);
		expect(page.document.querySelector("form")).toBeNull();
	});

	test("never sends an Authorization header or stores anything in the browser", async () => {
		const page = open(URL_WITH_CODE);
		await render(page);
		type(page, VALUE);
		await submit(page);

		for (const call of page.calls) {
			expect(JSON.stringify(call.init.headers ?? {}).toLowerCase()).not.toContain(
				"authorization",
			);
		}
		expect(page.win.localStorage.length).toBe(0);
		expect(page.win.sessionStorage.length).toBe(0);
	});

	test("says the link is spent when the daemon answers 404 for the name", async () => {
		const page = open(URL_WITH_CODE, () => new Response("no such code", { status: 404 }));

		await render(page);

		expect(text(page).toLowerCase()).toContain("expired");
		expect(page.document.querySelector("input")).toBeNull();
	});

	test("says the link is spent, clears the field and stops when the daemon answers 404 on submit", async () => {
		const page = open(URL_WITH_CODE, ({ init }) =>
			init.method === "POST"
				? new Response("no such code", { status: 404 })
				: Response.json({ name: "db/pg1" }),
		);
		await render(page);
		const input = type(page, VALUE);

		await submit(page);

		expect(text(page).toLowerCase()).toContain("expired");
		expect(input.value).toBe("");
		expect(page.document.querySelector("form")).toBeNull();
		expect(text(page)).not.toContain(VALUE);
	});

	test("keeps the form and the typed value when the daemon refuses the value, so the human can fix it", async () => {
		const page = open(URL_WITH_CODE, ({ init }) =>
			init.method === "POST"
				? new Response("refused", { status: 400 })
				: Response.json({ name: "db/pg1" }),
		);
		await render(page);
		const input = type(page, VALUE);

		await submit(page);

		expect(page.document.querySelector("form")).not.toBeNull();
		expect(input.value).toBe(VALUE);
		expect(page.document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
		expect(text(page)).not.toContain("refused");
	});

	test("shows the throttled text, not unreachable, when the name lookup answers 429", async () => {
		const page = open(URL_WITH_CODE, () => new Response("too many requests", { status: 429 }));

		await render(page);

		const message = text(page);
		expect(message).toContain("Too many tries");
		expect(message).not.toContain("Could not reach");
		expect(page.document.querySelector("form")).toBeNull();
	});

	test("keeps the form when the daemon is unreachable on submit", async () => {
		const page = open(URL_WITH_CODE, ({ init }) => {
			if (init.method === "POST") throw new TypeError("Failed to fetch");
			return Response.json({ name: "db/pg1" });
		});
		await render(page);
		const input = type(page, VALUE);

		await submit(page);

		expect(page.document.querySelector("form")).not.toBeNull();
		expect(input.value).toBe(VALUE);
		expect(page.document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
	});

	test("sends nothing while the field is empty", async () => {
		const page = open(URL_WITH_CODE);
		await render(page);

		await submit(page);

		expect(page.calls.filter((call) => call.init.method === "POST")).toEqual([]);
	});

	test("sends a second submit only once while the first is pending", async () => {
		let release: (response: Response) => void = () => {};
		const page = open(URL_WITH_CODE, ({ init }) =>
			init.method === "POST"
				? new Promise<Response>((resolve) => {
						release = resolve;
					})
				: Response.json({ name: "db/pg1" }),
		);
		await render(page);
		type(page, VALUE);

		await submit(page);
		await submit(page);
		release(new Response(null, { status: 204 }));
		await settle();

		expect(page.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
	});

	test("makes no call and tells the human to run setup again when the address has no code", async () => {
		const page = open(`${ORIGIN}/secret`);

		await render(page);

		expect(page.calls).toEqual([]);
		expect(text(page)).toContain("setup");
		expect(page.document.querySelector("input")).toBeNull();
	});

	test("the built entry renders into the window it is loaded in", async () => {
		const page = open(URL_WITH_CODE);
		const target = globalThis as Record<string, unknown>;
		const keys = ["window", "document", "fetch"] as const;
		const saved = new Map(keys.map((key) => [key, target[key]]));
		Object.assign(target, {
			window: page.win,
			document: page.document,
			fetch: page.fetchFn,
		});

		try {
			await import("../src/secret/page");
			await settle();
		} finally {
			for (const key of keys) {
				if (saved.get(key) === undefined) delete target[key];
				else target[key] = saved.get(key);
			}
		}

		expect(page.calls).toHaveLength(1);
		expect(text(page)).toContain("db/pg1");
	});
});
