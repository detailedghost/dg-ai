import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { dispatch } from "../src/dg";

let saved: string | undefined;

beforeEach(() => {
	saved = process.env.DG_HOME;
});

afterEach(() => {
	if (saved === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = saved;
});

test("dispatch makes a relative DG_HOME absolute so child processes started elsewhere keep the install", async () => {
	process.env.DG_HOME = "relative/dg-home";

	await dispatch(["dg-skills", "--version"]);

	expect(process.env.DG_HOME).toBe(resolve("relative/dg-home"));
});
