import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const BUNDLE_ADD = /git add -f (\.agents\/spec\/[^\s`]+?)\/? /g;

function bundleAdds(): { file: string; bundle: string; line: string }[] {
	const skills = join(REPO_ROOT, "plugins", "dg", "skills");
	const adds: { file: string; bundle: string; line: string }[] = [];
	for (const file of new Bun.Glob("**/*.md").scanSync(skills)) {
		for (const line of readRepoFile("plugins", "dg", "skills", file).split("\n")) {
			for (const match of line.matchAll(BUNDLE_ADD)) {
				adds.push({ file, bundle: match[1] ?? "", line });
			}
		}
	}
	return adds;
}

describe("spec bundle commits", () => {
	test("every forced add of a spec bundle leaves out its roundtable folder", () => {
		const adds = bundleAdds();
		expect(adds.length).toBeGreaterThanOrEqual(6);
		for (const { file, bundle, line } of adds) {
			expect({ file, line }).toEqual({
				file,
				line: expect.stringContaining(`':(exclude)${bundle}/roundtable/'`),
			});
		}
	});

	test("prd moves the whole bundle folder so untracked roundtable files go with it", () => {
		const prd = readRepoFile("plugins", "dg", "skills", "prd", "SKILL.md");
		expect(prd).not.toContain("git mv .agents/spec/<NNN>_<slug>/* ");
		expect(prd).toContain("git mv .agents/spec/<NNN>_<slug> .agents/spec/todo/<prd-slug>");
	});
});
