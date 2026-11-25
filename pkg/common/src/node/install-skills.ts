/**
 * Copy a skills tree as data. File contents are never spawned, sourced, or
 * passed to a shell. Symlinks are refused so a link cannot smuggle an
 * executable. Copied files are mode 0644 even when the source was executable.
 */

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { filesToInstall } from "../skill-files";
import { resolveDgPaths } from "./dg-paths";
import { assertNotBlocked } from "./layout";

export function skillsInstallDest(
	env: Record<string, string | undefined>,
	home: string = homedir(),
): string {
	if (env.DG_SKILLS_DEST) return env.DG_SKILLS_DEST;
	return resolveDgPaths({ env, homeDir: home }).skillsDir;
}

/** Throws while the legacy skills or agents folder has not moved to the default install destination; a `DG_SKILLS_DEST` override is never refused. */
export function assertSkillsDestMoved(
	env: Record<string, string | undefined>,
	home: string = homedir(),
): void {
	if (env.DG_SKILLS_DEST) return;
	const paths = resolveDgPaths({ env, homeDir: home });
	assertNotBlocked(paths, "skills");
	assertNotBlocked(paths, "personas");
}

/** Relative path with `/` separators. `pathSep` is injectable so tests can cover Windows. */
export function posixPath(path: string, pathSep: string = sep): string {
	return pathSep === "/" ? path : path.split(pathSep).join("/");
}

/** Regular files under root, relative and posix. Throws when it meets a symlink. */
export function listSkillTreeFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(
					`skills-only install refuses symlink ${posixPath(relative(root, abs))}`,
				);
			}
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			files.push(posixPath(relative(root, abs)));
		}
	};
	walk(root);
	return files;
}

export const RETIRED_SKILLS = ["browser", "channel-review", "phone-friend", "teach", "wait-what"];

/** SHA-256 of every SKILL.md dg shipped for a retired name; a copy with other content is kept. */
export const RETIRED_SKILL_HASHES: Record<string, string[]> = {
	browser: [
		"b969dfcd494d1232535baa69aaea096c45bdd4d7b05d08ba1934848f1725d03d",
		"d6a0bc0f0be59c15d66071106e9a3f80de76411a859376e70e9c45cecda431bc",
		"8dbdb20953aadcf2a0f9f6579ed228a7e884b2dd0ac044040ae08fbe606d1eb5",
		"cd5c05e9e74ceb784c358df6d94dc6d859fd5629abc0c440cdcad3914d3b7ee3",
		"dcfa9b73b33518527707f4d4cbf1dd6102b02656fb04f933cf4d7d134d6a15ee",
		"8000b280e0f6b100fed10da775e095ee64233a775753dfcd52af5a514e289384",
		"c4b44d927c2d44d8db1edb866a6c05cf93d35d9051e540b2cc1a1b6c2ddd7276",
		"e49882446a5b2fbb5dede1aa196d870377b0621eead0d3c00d8eefe89459bf84",
		"dda25c04098fc1b8d47287314bb9275f7e7c2d98c841c242ab25ac97d41323cc",
		"be8b6a3feb55e35abf4f827f36d2552ed977cee9a8cb2d44ba8e348c5c15079c",
		"ac752084481c4f2243a9957ef886185a758fc531aa7bfed47d3885c0f72ea712",
		"d4603c4b80e8c79c29abfe4705a6b8ddea19371db81b218f9feea451571c9829",
		"b0850898d8586b779f016d2cb1d07b79e9fee829e76aa199cba0c2070fa7e85f",
		"6cbaad37b810c89fb7c67f0a3eb251909ab0dceea67b3539d3d29992cc5f27c1",
		"2d984bc20bec7a2942d5c5a945447b1ab0bd8fac0db57414748c19054c3c8225",
		"68fe24a50f58c4519ab5531ca8958c9e1b260e7ab5a46c30e2844bd8a3d8fd3f",
		"cd7757c1c3d0d37f55937894924a373856ac298e4e967902b6b31f72c047ab49",
		"a8778e69801e97add7ab360f3bf2de713eaa198d120a13b573b83af866f5159e",
		"cae1f4cb6dc1542ac09648e92739ba3e85358cd4150ddcea9c02f37d09abf974",
		"5cc7d86cde958b20f160c5e7464f82b0a950dbdf6536bdfba486cae2208828d7",
		"3adf53ef20e804bc1c1097ac5ef2f477b206cccef07918b04026c6a7794a621d",
		"1a96b704aefa69f44264be622c937a0edabbe2929c25452ef724e5adaa170bd8",
		"0ead03f59800b9f61eda85ebe24c7ae24b9231d149d19f8ae4288e40e9cc3f36",
		"1661d1c79902c420156a040fc654a2a161c2a039f221fc394b071a5470747355",
		"8a6902729d3602d5dfef9f45b43b7cd90a4f3532cc169a7746629a92c66dac6f",
		"3397015189d9466b3709112e71d54644603da9ada241e96f5778ef42c5e22410",
		"ff38fc419e07fc60efbd24fdeca191c446a10de28de8fd2280bc00d04638f039",
		"b8f43b137d532362d02e66bd3ec994d7df0117dccac753e473f51d07f6912c23",
		"2a6a9bf6962b558cf0c418206ba8e942dc1cfa5e69e60d3ef30949238067c903",
		"4c76b530c8262cf18f34339b77b5abbd3ff5b9adcb7eba4e74944ca06e189689",
		"926fa3ec0b9a4df41092b7412fce783dd8d9b7b8adce16d40666c19dd466da4d",
		"d83397cd3e6d119e88b3d7076b1c70dae61dc2303d28f2c54551ef1018b1c189",
		"dbe38cc5affd5a9646aed5ec3b6cf7996a3a86b39d93f4509c8606873c1839cb",
		"2b4f458a849518d038d393ce4a95bfe110acad175ad49e4979b65b4369260278",
		"1f93ee9b3e672eeb85fb63076403db8dc818e010bfe40f0d12841237c2ce6886",
		"abba20a6b591f8e2782ba7bfc21cd89bac12509eb9ba662a2ead3df273bb5e3f",
		"87299ac43a0a7e83ccaff96f4a13a6d84771b9a69b058c239ba78230ade54847",
		"aecd7a52ae736542406fc2923bb1a7285e2f802aba89d3da4a484ba8ddc8128a",
	],
	"channel-review": [
		"7b485c917cb0ea11a89f7094230ef7a8b994e5a7f828a730f873dddf2d7f78bf",
		"6b245aeacc3baf4da214fe218354d62f6332ce5f634d92c40b975bfe3a5d6f62",
		"acb3d8953b4e96795b03d44a156961c6d2824b10bae4b70c421f266f7118fe26",
		"78ab89baddb467b84a916c62d3bb92fb015dba895fe0d8e77ce8354abbbc4023",
		"c750347942ad7ea1fc379a91fba5ee4c21685c7175217ad2d772874755ac892d",
		"d91fcd86bd850a4565b8a255ad59d38f70700f99c6d6445d0879db3bd0a1d70c",
		"10d038d8f34f1ff6e96b3b1cce0860d6c98a9aab9fd735e0e6ac18baf8110494",
		"07afcb0dee1fd889e08baf6873cb2bc0dd70703b59381e672875f4175a033e99",
		"e16939181f85a347fd336e634f1299b6fff656edd6b48d663e3910aa5f86f498",
		"8e25cd2de02f83a2c2b090152e9094a66771d77f44128a238770e3432ac87f9c",
		"d468349b27183f60be6a644abf1aae40530debc6793462a074d335a629026bb2",
		"cb8f31aec020130817b0c139b55ae3f2d29adbdc8c338d45a1cd0201002fb765",
		"9011768b1c46042d7a823d0e13b5e401f37c4b453bdd66cf34f3fa54aed165d6",
		"d96f665bd908b76a5d1eb0406f26c522e536135c94b9c95e5b0f4d6c34beab0b",
		"cb2211bf7a5037e39efee9a758bab44d86a9900964f3edffd3f15bf27b193f12",
		"7a3b86b56cd264259eaf337879b80aa3162687af0af752b50032625a1a91c48d",
		"858ed9659d064dd1d2a1c3439ab5437c1937512bd8d231ecd8015662790ce780",
		"88e800b316a406760861f94cff43afd9ebfec2445ca54766a22ec2867d1782ca",
		"7db7be71f7e70e268a73a706018573b0e53ea0a5936c19eccd89254d2659b044",
		"567f078cf2f843266a3b820abd3580079acf5a56818a1cfb26f5c65ae784f6e1",
		"a1f922857d9f5b85cf46d6db449922b0f2c2fee51b3d09ed96fb8bb9f2b3b66f",
		"897625648a0efaef34d419b36c77f94c9ae91374762be449ce1d48bd3b7282e6",
		"3763b37452965ac607f7c659cf6ec72d04e7561556e47b7044f097e80ff6cc1a",
		"f41b786d65ade0504731f8e2fd4a00a306e73ae6e299b6a9b9e4bc8af3f1252a",
		"3dab5eaae0dd6b020932b0be04d9b8939d1f8a02f769caa22a40281833454aa1",
		"7070ba50514a29fec3ebc5dccad98a3b07052661ba66dbf7989835b65b0b2422",
		"7ccbea78fcc77babbbd71772ff175fe20b3687f9c787db754e03079962167f72",
		"914f066a1cf64ac44d474c23d5eafe5d0aac4fa22d14cf640a2546a543381bbc",
		"04ea9d6c7f3ee28916b93a8c059f1e23b97ccf36f5a53cb82aef76d22cd76a15",
		"1950365fd2ac8c8a83f292ab71478995fefc771c979b24095702c034101a39fe",
		"9dacc404d611ee2266f1a0d44ea39bac7417db833f6f99a4e1426c70926b1cc5",
		"8ecf481714a8f76af0ad4929eb1dd2c163966232fe32e6ba43ace02b197f07dc",
		"46e7cda11330b7155aa012ce9a0d083daf3a80627f3bdf1430786d64e88d27b7",
		"82bbb8c03851fe8fb9eb041b25abff50dcd49ad76768f7269d837957445393ad",
	],
	teach: [
		"b32cdde3ab7f7239d157dd2225c984e48c02aa981cb962b42cdda5cdd1c4dc68",
		"bb06ec5c6763216f76a7af5fbbea839476008747740ded023d285a5afddbd3c9",
		"f5c44555744159f345cfdd1ab1eede4977f06cf31b911edffc48e35747b313a9",
		"d173128190d9450759d3ca5a261987448e176665fabb9cd7a0ffba4d4f006020",
	],
	"wait-what": [
		"3ff07fa007759e417d95c4885ed333a84119cc0d621f7e3d805ca46b6ffb3dd6",
		"6f40fe8148898ee8cb306b8fec3f8f674ee346f5ef54bf9f2d2790e43e1e1f4a",
		"9b0cee4706ad7eb61490d3cb997b1dad7cfebd2dc974e4735b5a2fb65a1bcb3e",
		"f923f0a108954acb787d4b9d331bc44525ab70721df0e00e719284007a773bd0",
	],
};

function isRemovableRetired(dest: string, name: string): boolean {
	const known = RETIRED_SKILL_HASHES[name];
	if (!known) return true;
	const skill = join(dest, name, "SKILL.md");
	try {
		return known.includes(createHash("sha256").update(readFileSync(skill)).digest("hex"));
	} catch {
		return false;
	}
}

/**
 * Replace each skill directory in dest with the files selected from source.
 * Entries in dest that are not those skill directories are left in place.
 * Returns the relative paths written.
 */
export function installSkillTree(source: string, dest: string): string[] {
	const files = filesToInstall(listSkillTreeFiles(source));
	if (files.length === 0) {
		throw new Error(`no skill instruction files in ${source}`);
	}
	const skillNames = new Set(files.map((file) => file.split("/")[0]));
	mkdirSync(dest, { recursive: true });
	for (const name of RETIRED_SKILLS) {
		if (isRemovableRetired(dest, name)) rmSync(join(dest, name), { recursive: true, force: true });
	}
	for (const name of skillNames) {
		rmSync(join(dest, name), { recursive: true, force: true });
	}
	for (const file of files) {
		const from = join(source, file);
		const to = join(dest, file);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
		chmodSync(to, 0o644);
	}
	return files;
}

/** Skills-only install writes the personas beside the skills directory. */
export function personasDest(skillsDest: string): string {
	return join(dirname(skillsDest), "agents");
}

/** Persona files in plugins/dg/agents. Throws on a symlink so a bad source fails before any write. */
export function listPersonaFiles(repoRoot: string): string[] {
	const source = join(repoRoot, "plugins", "dg", "agents");
	if (!existsSync(source)) return [];
	const names: string[] = [];
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) {
			throw new Error(
				`skills-only install refuses symlink plugins/dg/agents/${entry.name}`,
			);
		}
		if (entry.isFile()) names.push(entry.name);
	}
	return names.sort();
}

/**
 * Copy every persona so a skills-only install can load them without the
 * compiled binary. A link at a destination is replaced, never followed.
 */
export function installPersonas(
	repoRoot: string,
	names: string[],
	skillsDest: string,
): string[] {
	const destDir = personasDest(skillsDest);
	mkdirSync(destDir, { recursive: true });
	for (const name of names) {
		const to = join(destDir, name);
		rmSync(to, { force: true });
		copyFileSync(join(repoRoot, "plugins", "dg", "agents", name), to);
		chmodSync(to, 0o644);
	}
	return names;
}
