import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Window } from "happy-dom";
import { cssSelectorFor, injectTheme, waitForEl } from "@/lib/picker";

const window = new Window();
const document = window.document as unknown as Document;

Object.defineProperty(globalThis, "document", {
	configurable: true,
	value: document,
});

function expectUniqueSelectorFor(target: Element): string {
	const selector = cssSelectorFor(target);
	const matches = document.querySelectorAll(selector);

	expect(selector).not.toBe("");
	expect(matches).toHaveLength(1);
	expect(matches.item(0)).toBe(target);

	return selector;
}

describe("cssSelectorFor", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	it("returns a unique selector for an element with data-testid", () => {
		document.body.innerHTML = `
			<button type="button">Cancel</button>
			<button type="button" data-testid="save-action">Save</button>
		`;
		const target = document.querySelector('[data-testid="save-action"]');

		expect(target).not.toBeNull();
		const selector = expectUniqueSelectorFor(target as Element);
		expect(selector).toContain("data-testid");
	});

	it("preserves the legacy structural selector when it is already unique", () => {
		document.body.innerHTML = `<button type="button">Save</button>`;
		const target = document.querySelector("button");

		expect(target).not.toBeNull();
		const selector = expectUniqueSelectorFor(target as Element);
		expect(selector).toBe("body > button");
	});

	it("returns a unique selector for a deeply nested element", () => {
		document.body.innerHTML = `
			<main>
				<section>
					<div><article><ul><li><button><span>Decoy</span></button></li></ul></article></div>
				</section>
				<section>
					<div>
						<article>
							<ul>
								<li><button><span data-target>Target</span></button></li>
							</ul>
						</article>
					</div>
				</section>
			</main>
		`;
		const target = document.querySelector("[data-target]");

		expect(target).not.toBeNull();
		expectUniqueSelectorFor(target as Element);
	});
});

describe("injectTheme — setup-phase accent variable (slice 3)", () => {
	it("exposes --accent-setup alongside --accent/--accent2 in both color schemes", () => {
		const root = document.createElement("div");

		injectTheme(root);

		const css = root.querySelector("style")?.textContent ?? "";
		const [dark, light] = css.split(':host([data-theme="light"])');
		expect(dark).toContain("--accent-setup:");
		expect(light).toContain("--accent-setup:");
	});
});

describe("waitForEl", () => {
	it("does not throw when playback receives malformed CSS", async () => {
		await expect(waitForEl("[", 0)).resolves.toBeNull();
	});

	it("queries once initially, then safely polls for a valid selector", async () => {
		const querySelector = spyOn(document, "querySelector");
		try {
			const pending = waitForEl("#later", 250);
			expect(querySelector).toHaveBeenCalledTimes(1);

			setTimeout(() => {
				const later = document.createElement("div");
				later.id = "later";
				document.body.appendChild(later);
			}, 10);

			await expect(pending).resolves.toHaveProperty("id", "later");
			expect(querySelector).toHaveBeenCalledTimes(2);
		} finally {
			querySelector.mockRestore();
		}
	});
});
