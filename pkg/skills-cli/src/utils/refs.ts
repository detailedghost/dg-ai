/** Resolve PR/URL refs to GitHub URLs. Shared by `batch-open` and `launch`. */

import { readDgToml } from "@dg/common/node/dg-toml";

export type Config = { defaultRepo?: string; aliases?: Record<string, string> };

/** Ref aliases and the default repo from the [refs] table of config.toml. */
export function loadConfig(): Config {
	const { default_repo, aliases } = readDgToml().refs;
	return { ...(default_repo === undefined ? {} : { defaultRepo: default_repo }), aliases };
}

export function resolveRef(
	ref: string,
	cfg: Config,
	defaultRepo: string | undefined,
): string {
	if (/^https?:\/\//.test(ref)) return ref;

	const aliases = cfg.aliases ?? {};

	const hashMatch = ref.match(/^(.+)#(\d+)$/);
	if (hashMatch) {
		const [, repoPart, num] = hashMatch;
		const repo = aliases[repoPart] ?? repoPart;
		return `https://github.com/${repo}/pull/${num}`;
	}

	if (/^\d+$/.test(ref)) {
		const repo = defaultRepo ?? cfg.defaultRepo;
		if (!repo) {
			throw new Error(
				`bare PR number "${ref}" needs a repo — pass --repo owner/repo or set defaultRepo in config`,
			);
		}
		return `https://github.com/${aliases[repo] ?? repo}/pull/${ref}`;
	}

	throw new Error(
		`unrecognized ref: "${ref}" (use a URL, owner/repo#num, alias#num, or bare num with --repo)`,
	);
}

/** Resolve many refs at once using config + optional default repo. */
export function resolveRefs(refs: string[], defaultRepo?: string): string[] {
	const cfg = loadConfig();
	return refs.map((r) => resolveRef(r, cfg, defaultRepo));
}
