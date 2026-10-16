import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
	installSkillTree,
	listSkillTreeFiles,
	posixPath,
	skillsInstallDest,
} from "../src/node/install-skills";

const SENTINEL_NAME = "executed-by-skill.txt";

function tree(root: string): void {
	mkdirSync(join(root, "google-sms-cleanup"), { recursive: true });
	mkdirSync(join(root, "browser", "references"), { recursive: true });
	mkdirSync(join(root, "notes"), { recursive: true });
	writeFileSync(join(root, "README.md"), "developer catalog\n");
	writeFileSync(join(root, "notes", "not-a-skill.md"), "skip me\n");
	writeFileSync(
		join(root, "google-sms-cleanup", "SKILL.md"),
		"---\nname: google-sms-cleanup\n---\n$(touch executed)\n",
	);
	writeFileSync(
		join(root, "browser", "SKILL.md"),
		"---\nname: browser\nrequires: [extension]\n---\n",
	);
	writeFileSync(join(root, "browser", "references", "install.md"), "steps\n");
	const script = join(root, "google-sms-cleanup", "explode.sh");
	writeFileSync(script, "#!/bin/sh\necho executed > \"$(dirname \"$0\")/" + SENTINEL_NAME + "\"\n");
	chmodSync(script, 0o755);
	chmodSync(join(root, "google-sms-cleanup", "SKILL.md"), 0o755);
}

function filesUnder(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			const info = statSync(abs);
			if (info.isDirectory()) visit(abs);
			else out.push(relative(root, abs).split(sep).join("/"));
		}
	};
	visit(root);
	return out.sort();
}

describe("posixPath", () => {
	test("keeps slash paths and rewrites a Windows separator", () => {
		expect(posixPath("browser/SKILL.md", "/")).toBe("browser/SKILL.md");
		expect(posixPath("browser\\references\\install.md", "\\")).toBe(
			"browser/references/install.md",
		);
	});
});

describe("skillsInstallDest", () => {
	test("prefers DG_SKILLS_DEST, then DG_HOME/skills, then ~/.dg/skills", () => {
		expect(skillsInstallDest({ DG_SKILLS_DEST: "/opt/skills", DG_HOME: "/opt/dg" }, "/home/u")).toBe(
			"/opt/skills",
		);
		expect(skillsInstallDest({ DG_HOME: "/opt/dg" }, "/home/u")).toBe("/opt/dg/skills");
		expect(skillsInstallDest({}, "/home/u")).toBe("/home/u/.dg/skills");
		expect(skillsInstallDest({ DG_SKILLS_DEST: "", DG_HOME: "" }, "/home/u")).toBe(
			"/home/u/.dg/skills",
		);
	});
});

describe("installSkillTree", () => {
	test("copies skill files as data, strips the executable bit, and leaves the rest of dest alone", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-install-"));
		const source = join(directory, "src");
		const dest = join(directory, "dest");
		try {
			tree(source);
			mkdirSync(dest, { recursive: true });
			writeFileSync(join(dest, "unrelated.txt"), "keep\n");
			mkdirSync(join(dest, "google-sms-cleanup"), { recursive: true });
			writeFileSync(join(dest, "google-sms-cleanup", "stale.md"), "old\n");

			expect(listSkillTreeFiles(source).sort()).toEqual([
				"README.md",
				"browser/SKILL.md",
				"browser/references/install.md",
				"google-sms-cleanup/SKILL.md",
				"google-sms-cleanup/explode.sh",
				"notes/not-a-skill.md",
			]);
			Bun.spawnSync(["mkfifo", join(source, "google-sms-cleanup", "pipe")]);
			const written = installSkillTree(source, dest);

			expect(written).toEqual([
				"browser/SKILL.md",
				"browser/references/install.md",
				"google-sms-cleanup/SKILL.md",
				"google-sms-cleanup/explode.sh",
			]);
			expect(filesUnder(dest)).toEqual([
				"browser/SKILL.md",
				"browser/references/install.md",
				"google-sms-cleanup/SKILL.md",
				"google-sms-cleanup/explode.sh",
				"unrelated.txt",
			]);
			expect(readFileSync(join(dest, "unrelated.txt"), "utf8")).toBe("keep\n");
			expect(readFileSync(join(dest, "google-sms-cleanup", "SKILL.md"), "utf8")).toContain(
				"$(touch executed)",
			);
			expect(readFileSync(join(dest, "google-sms-cleanup", "explode.sh"), "utf8")).toContain(
				"#!/bin/sh",
			);
			for (const file of written) {
				expect(statSync(join(dest, file)).mode & 0o777).toBe(0o644);
			}
			expect(statSync(join(source, "google-sms-cleanup", "explode.sh")).mode & 0o111).not.toBe(0);
			expect(filesUnder(source)).not.toContain("google-sms-cleanup/" + SENTINEL_NAME);
			expect(filesUnder(dest)).not.toContain("google-sms-cleanup/" + SENTINEL_NAME);
			expect(existsSync(join(dest, "notes", "not-a-skill.md"))).toBe(false);
			expect(existsSync(join(dest, "README.md"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses a symlink and does not run the link target", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-link-"));
		const source = join(directory, "src");
		const dest = join(directory, "dest");
		const outside = join(directory, "outside.sh");
		try {
			tree(source);
			writeFileSync(outside, "#!/bin/sh\necho executed > \"" + join(directory, SENTINEL_NAME) + "\"\n");
			chmodSync(outside, 0o755);
			symlinkSync(outside, join(source, "google-sms-cleanup", "linked.sh"));
			mkdirSync(dest, { recursive: true });
			writeFileSync(join(dest, "unrelated.txt"), "keep\n");

			expect(() => installSkillTree(source, dest)).toThrow(/refuses symlink/);
			expect(readFileSync(join(dest, "unrelated.txt"), "utf8")).toBe("keep\n");
			expect(existsSync(join(directory, SENTINEL_NAME))).toBe(false);
			expect(filesUnder(source)).not.toContain("google-sms-cleanup/" + SENTINEL_NAME);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects a tree with no SKILL.md", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-empty-"));
		try {
			mkdirSync(join(directory, "src"), { recursive: true });
			writeFileSync(join(directory, "src", "README.md"), "only a readme\n");
			expect(() => installSkillTree(join(directory, "src"), join(directory, "dest"))).toThrow(
				/no skill instruction files/,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
