import { beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { cssSelectorFor, waitForEl } from "@/lib/picker";

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

describe("waitForEl", () => {
	it("does not throw when playback receives malformed CSS", async () => {
		await expect(waitForEl("[", 0)).resolves.toBeNull();
	});
});
