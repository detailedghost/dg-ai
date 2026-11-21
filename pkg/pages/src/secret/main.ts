import {
	SECRET_CODE_HEADER,
	SECRET_CODE_KEY,
	SECRET_INTAKE_PATH,
} from "@dg/common";

const RERUN = "Run the dg db setup command again to get a new link.";
const TEXT = {
	missingCode: `This link has no code. ${RERUN}`,
	expired: `This link has expired or was already used. ${RERUN}`,
	unreachable: "Could not reach the daemon. Check that it is running and try again.",
	notAccepted: "The daemon did not accept that value. Check it and try again.",
	throttled: "Too many tries. Wait a minute and try again.",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

async function readName(
	win: Window,
	fetchFn: typeof fetch,
	code: string,
): Promise<{ name: string } | "expired" | "throttled" | "unreachable"> {
	const response = await fetchFn(`${win.location.origin}${SECRET_INTAKE_PATH}`, {
		headers: { [SECRET_CODE_HEADER]: code },
		cache: "no-store",
	}).catch(() => undefined);
	if (response === undefined) return "unreachable";
	if (response.status === 404) return "expired";
	if (response.status === 429) return "throttled";
	const body: unknown = response.ok
		? await response.json().catch(() => undefined)
		: undefined;
	const name = (body as { name?: unknown } | undefined)?.name;
	return typeof name === "string" ? { name } : "unreachable";
}

/** Asks a human for one credential value and posts it to the daemon with the one-time code from the address. */
export async function renderSecretPage(
	win: Window,
	fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
	const doc = win.document;
	const root = doc.getElementById("app");
	if (!root) return;
	const code = new URLSearchParams(win.location.hash.slice(1)).get(SECRET_CODE_KEY);
	win.history.replaceState(
		win.history.state,
		"",
		win.location.pathname + win.location.search,
	);

	const page = element(doc, "main", "secret");
	page.append(element(doc, "h1", "secret__title", "Enter a secret"));
	root.replaceChildren(page);
	const message = element(doc, "p", "secret__message");
	const say = (text: string, role: "alert" | "status") => {
		message.textContent = text;
		message.setAttribute("role", role);
	};
	page.append(message);

	if (code === null) {
		say(TEXT.missingCode, "status");
		return;
	}
	const found = await readName(win, fetchFn, code);
	if (typeof found === "string") {
		say(TEXT[found], "status");
		return;
	}

	const form = element(doc, "form", "secret__form");
	const label = element(doc, "label", "secret__label", "Secret value");
	label.htmlFor = "secret-value";
	const input = element(doc, "input", "secret__input");
	input.id = "secret-value";
	input.type = "password";
	input.setAttribute("autocomplete", "off");
	input.setAttribute("autocapitalize", "off");
	input.spellcheck = false;
	const button = element(doc, "button", "secret__submit", "Save");
	button.type = "submit";
	form.append(label, input, button);
	const name = element(doc, "p", "secret__name");
	name.append("Credential: ", element(doc, "code", "secret__code", found.name));
	page.insertBefore(name, message);
	page.insertBefore(form, message);
	input.focus();

	let pending = false;
	const finish = (text: string) => {
		input.value = "";
		form.remove();
		name.remove();
		say(text, "status");
	};
	const send = async (value: string) => {
		const response = await fetchFn(`${win.location.origin}${SECRET_INTAKE_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, value }),
		}).catch(() => undefined);
		if (response === undefined) return say(TEXT.unreachable, "alert");
		if (response.status === 204) {
			return finish(`Saved ${found.name}. You can close this tab and return to your agent.`);
		}
		if (response.status === 404) return finish(TEXT.expired);
		say(response.status === 429 ? TEXT.throttled : TEXT.notAccepted, "alert");
	};
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (pending || input.value.length === 0) return;
		pending = true;
		button.disabled = true;
		void send(input.value).finally(() => {
			pending = false;
			button.disabled = false;
		});
	});
}
