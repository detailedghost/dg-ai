import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyPatchInputs } from "../../src/hooks/adapters/codex-apply-patch";
import { hookWorld, SESSION } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

function patchEvent(patch: string, cwd: string) {
	return {
		session_id: SESSION,
		tool_name: "apply_patch",
		cwd,
		tool_input: { command: patch },
	};
}

function twoFilePatch() {
	return [
		"*** Begin Patch",
		"*** Update File: src/one.ts",
		"@@",
		" const keep = 1;",
		"-const old = 2;",
		"+const fresh = 3;",
		"*** Add File: src/two.ts",
		"+export const two = 2;",
		"*** End Patch",
	].join("\n");
}

describe("codex apply_patch adapter", () => {
	test("turns one patch with two files into two Edit-shaped inputs", () => {
		const inputs = applyPatchInputs(patchEvent(twoFilePatch(), world.work));
		expect(inputs).toHaveLength(2);
		expect(inputs.map((i) => i.tool_name)).toEqual(["Edit", "Edit"]);
		expect(inputs.map((i) => i.tool_input?.file_path)).toEqual([
			join(world.work, "src/one.ts"),
			join(world.work, "src/two.ts"),
		]);
		expect(inputs[0]!.tool_input?.new_string).toContain("const fresh = 3;");
		expect(inputs[0]!.tool_input?.new_string).not.toContain("const old = 2;");
		expect(inputs[1]!.tool_input?.new_string).toContain(
			"export const two = 2;",
		);
	});

	test("keeps the session id and cwd on each translated input", () => {
		for (const input of applyPatchInputs(
			patchEvent(twoFilePatch(), world.work),
		)) {
			expect(input.session_id).toBe(SESSION);
			expect(input.cwd).toBe(world.work);
		}
	});

	test("emits nothing for a delete-only patch", () => {
		const patch = [
			"*** Begin Patch",
			"*** Delete File: src/gone.ts",
			"*** End Patch",
		].join("\n");
		expect(applyPatchInputs(patchEvent(patch, world.work))).toEqual([]);
	});

	test("returns the event unchanged in a single-item list for a non apply_patch tool", () => {
		const event = {
			session_id: SESSION,
			tool_name: "Edit",
			tool_input: { file_path: "/x", new_string: "y" },
		};
		expect(applyPatchInputs(event)).toEqual([event]);
	});

	test("the spelling hook blocks a Codex patch that adds a British spelling", async () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/one.ts",
			"@@",
			"-const a = 1;",
			"+const colour = 3;",
			"*** End Patch",
		].join("\n");
		const r = await world.run("spelling", patchEvent(patch, world.work));
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("colour -> color");
	});

	test("the spelling hook passes a Codex patch with clean text", async () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/one.ts",
			"@@",
			"-const a = 1;",
			"+const color = 3;",
			"*** End Patch",
		].join("\n");
		expect(
			(await world.run("spelling", patchEvent(patch, world.work))).code,
		).toBe(0);
	});

	test("uses the Move to path as the written file", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old-name.ts",
			"*** Move to: src/new-name.ts",
			"@@",
			"-const a = 1;",
			"+const b = 2;",
			"*** End Patch",
		].join("\n");
		const inputs = applyPatchInputs(patchEvent(patch, world.work));
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.tool_input?.file_path).toBe(
			join(world.work, "src/new-name.ts"),
		);
		expect(inputs[0]?.tool_input?.new_string).toBe("const b = 2;");
	});

	test("joins the added lines of every hunk of one Update", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/one.ts",
			"@@ first",
			"-a",
			"+first added",
			"@@ second",
			" context",
			"+second added",
			"*** End Patch",
		].join("\n");
		const inputs = applyPatchInputs(patchEvent(patch, world.work));
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.tool_input?.new_string).toBe("first added\nsecond added");
	});

	test("returns nothing when tool_input.command is not a string", () => {
		for (const command of [undefined, 42, ["*** Begin Patch"], { a: 1 }]) {
			const event = {
				session_id: SESSION,
				tool_name: "apply_patch",
				cwd: world.work,
				tool_input: { command },
			};
			expect(applyPatchInputs(event)).toEqual([]);
		}
	});

	test("returns nothing when tool_input is missing", () => {
		expect(
			applyPatchInputs({ session_id: SESSION, tool_name: "apply_patch" }),
		).toEqual([]);
	});

	test("ignores the No newline marker", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/one.ts",
			"@@",
			"-old",
			"\\ No newline at end of file",
			"+fresh",
			"\\ No newline at end of file",
			"*** End Patch",
		].join("\n");
		const inputs = applyPatchInputs(patchEvent(patch, world.work));
		expect(inputs[0]?.tool_input?.new_string).toBe("fresh");
	});

	test("keeps an Add File with an empty body as an empty string", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: src/empty.ts",
			"*** End Patch",
		].join("\n");
		const inputs = applyPatchInputs(patchEvent(patch, world.work));
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.tool_input?.new_string).toBe("");
	});

	test("keeps an absolute path unchanged", () => {
		const abs = join(world.work, "abs/one.ts");
		const patch = [
			"*** Begin Patch",
			`*** Add File: ${abs}`,
			"+x",
			"*** End Patch",
		].join("\n");
		const inputs = applyPatchInputs(patchEvent(patch, world.work));
		expect(inputs[0]?.tool_input?.file_path).toBe(abs);
	});

	test("resolves a relative path against the process cwd when the event has no cwd", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: src/rel.ts",
			"+x",
			"*** End Patch",
		].join("\n");
		const inputs = applyPatchInputs({
			session_id: SESSION,
			tool_name: "apply_patch",
			tool_input: { command: patch },
		});
		expect(inputs[0]?.tool_input?.file_path).toBe(
			join(process.cwd(), "src/rel.ts"),
		);
	});
});
