/** Every class the canvas code creates must carry a rule, or the second view renders unstyled. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relative: string): string {
	return readFileSync(
		fileURLToPath(new URL(relative, import.meta.url)),
		"utf8",
	);
}

/** Class-name literals the canvas sources assign, so a newly added element cannot slip past this test. */
function canvasClassNames(): string[] {
	const sources = [
		read("../lib/features/chat-canvas.ts"),
		read("../entrypoints/chat/main.ts"),
	].join("\n");
	const found = new Set<string>();
	for (const match of sources.matchAll(
		/"(chat-canvas(?:__[a-z-]+)?|chat-node__drag)"/g,
	)) {
		found.add(match[1] as string);
	}
	return [...found];
}

test("the canvas view's own class names each have a styling rule", () => {
	const names = canvasClassNames();
	const css = read("../entrypoints/chat/style.css");

	expect(names).toContain("chat-canvas");
	expect(names).toContain("chat-canvas__board");
	expect(names).toContain("chat-node__drag");
	for (const name of names) {
		expect(css).toContain(`.${name}`);
	}
});

test("the canvas rules use theme variables rather than hard-coded colors", () => {
	const css = read("../entrypoints/chat/style.css");
	const canvasRules = css.slice(css.indexOf(".chat-canvas {"));

	expect(canvasRules.length).toBeGreaterThan(0);
	expect(/#[0-9a-fA-F]{3,8}\b/.test(canvasRules)).toBe(false);
	expect(canvasRules).toContain("var(--chat-");
});
