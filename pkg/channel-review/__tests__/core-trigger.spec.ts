import { describe, expect, test } from "bun:test";
import { prKey } from "../src/state";
import { parsePrUrl, parseReadiness, parseTrigger } from "../src/trigger";

const HOSTS = { github: [], gitlab: [] };
const OPTIONS = { ownerToken: "!owner", hosts: HOSTS };
const PHRASES = [
	"ready",
	"fixed",
	"addressed",
	"updated",
	"ptal",
	"re-review",
	"good to go",
];
const GITHUB_URL = "https://github.com/o/r/pull/12";
const GITLAB_URL = "https://gitlab.com/g/p/-/merge_requests/5";

describe("parseTrigger", () => {
	test("preserves a model name's case and accepts an uppercase flag", () => {
		expect(
			parseTrigger(`!owner $review ${GITHUB_URL} ~MODEL Opus-4.6`, OPTIONS),
		).toMatchObject({ kind: "run", model: "Opus-4.6" });
	});
	test.each(["", "~comment", "--help", "bad;name"])(
		"rejects invalid or missing model: %s",
		(model) => {
			expect(
				parseTrigger(`!owner $review ${GITHUB_URL} ~model ${model}`, OPTIONS),
			).toEqual({ kind: "error", code: "CR-108" });
		},
	);
	test("returns run with url, host, spice, comment and no agent from Teams HTML with an at-mention and a link", () => {
		const html = `<p><at>Review Bot</at> !owner $review <a href="${GITHUB_URL}">the PR</a> ~spice 3 ~comment</p>`;
		const result = parseTrigger(html, OPTIONS);
		expect(result).toMatchObject({
			kind: "run",
			url: GITHUB_URL,
			number: 12,
			host: "github",
			spice: 3,
			comment: true,
			stacked: false,
			fun: false,
		});
		expect((result as { agent?: string }).agent).toBeUndefined();
	});

	test.each(['href = "', "href\t=\n'"])(
		"extracts a descriptive title's target with whitespace around %s",
		(attribute) => {
			const delimiter = attribute.at(-1);
			const html = `!owner $review <a ${attribute}${GITHUB_URL}?a=1&amp;b=2${delimiter}>Fix the linked records (owner's follow-up)…</a>`;
			expect(parseTrigger(html, OPTIONS)).toMatchObject({
				kind: "run",
				url: GITHUB_URL,
				number: 12,
				host: "github",
			});
		},
	);

	test("uses href rather than data-href or the displayed URL", () => {
		const html = `!owner $review <a data-href="${GITLAB_URL}" href = "${GITHUB_URL}">${GITLAB_URL}</a>`;
		expect(parseTrigger(html, OPTIONS)).toMatchObject({ kind: "run", url: GITHUB_URL });
	});

	test("does not treat data-href as a link target", () => {
		expect(
			parseTrigger(`!owner $review <a data-href="${GITHUB_URL}">Fix records…</a>`, OPTIONS),
		).toEqual({ kind: "error", code: "CR-101" });
	});

	test("does not infer a target from a descriptive title without a URL", () => {
		expect(
			parseTrigger("!owner $review Fix the linked records (owner's follow-up)…", OPTIONS),
		).toEqual({ kind: "error", code: "CR-101" });
	});

	test("returns the same result when the at-mention is absent", () => {
		const withMention = `<at>Review Bot</at> !owner $review ${GITHUB_URL} ~spice 3 ~comment`;
		const without = `!owner $review ${GITHUB_URL} ~spice 3 ~comment`;
		expect(parseTrigger(without, OPTIONS)).toEqual(
			parseTrigger(withMention, OPTIONS),
		);
	});

	test("matches tokens case-insensitively and in any order", () => {
		const shuffled = `~SPICE 3 ${GITHUB_URL} ~Comment $REVIEW !OWNER ~agent codex`;
		expect(parseTrigger(shuffled, OPTIONS)).toMatchObject({
			kind: "run",
			url: GITHUB_URL,
			spice: 3,
			comment: true,
			agent: "codex",
		});
	});

	test("accepts $thrash in place of $review", () => {
		expect(parseTrigger(`!owner $thrash ${GITHUB_URL}`, OPTIONS)).toMatchObject(
			{ kind: "run", url: GITHUB_URL },
		);
	});

	test("uses the owner token passed in the options", () => {
		expect(
			parseTrigger(`!bob $review ${GITHUB_URL}`, {
				ownerToken: "!bob",
				hosts: HOSTS,
			}),
		).toMatchObject({ kind: "run" });
		expect(
			parseTrigger(`!owner $review ${GITHUB_URL}`, {
				ownerToken: "!bob",
				hosts: HOSTS,
			}),
		).toEqual({ kind: "ignore" });
	});

	test.each([
		["with $review", `!owner $review $help`, "review"],
		["with $thrash", `!owner $help $thrash`, "review"],
		["with $address", `!owner $help $address`, "address"],
		["with $emoji", `!owner $help $emoji`, "emoji"],
		["without a command", `!owner $help`, "overview"],
		[
			"with a link",
			`<at>Review Bot</at> !owner $help ${GITHUB_URL}`,
			"overview",
		],
	] as const)("returns help %s", (_name, text, topic) => {
		expect(parseTrigger(text, OPTIONS)).toEqual({ kind: "help", topic });
	});

	test.each([
		["with a slot", "!owner $emoji Approved", { kind: "emoji", slot: "approved" }],
		["without a slot", "!owner $emoji", { kind: "emoji" }],
		["without the owner gate", "$emoji approved", { kind: "ignore" }],
	] as const)("parses $emoji %s", (_name, text, expected) => {
		expect(parseTrigger(text, OPTIONS)).toEqual(expected);
	});

	test("returns an address request with its flags", () => {
		expect(
			parseTrigger(`!owner $address ${GITHUB_URL} ~no-ci ~fun`, OPTIONS),
		).toEqual({
			kind: "address",
			url: GITHUB_URL,
			number: 12,
			host: "github",
			noCi: true,
		});
	});

	test("ignores review-only flags on an address request", () => {
		expect(
			parseTrigger(
				`!owner $address ${GITLAB_URL} ~spice 9 ~agent nope ~stacked ~comment`,
				OPTIONS,
			),
		).toEqual({
			kind: "address",
			url: GITLAB_URL,
			number: 5,
			host: "gitlab",
			noCi: false,
		});
	});

	test.each(["$review", "$thrash"])(
		"refuses $address with %s in one message",
		(command) => {
			expect(
				parseTrigger(`!owner $address ${command} ${GITHUB_URL}`, OPTIONS),
			).toEqual({
				kind: "error",
				code: "CR-105",
			});
		},
	);

	test("reports a missing link on an address request", () => {
		expect(parseTrigger("!owner $address", OPTIONS)).toEqual({
			kind: "error",
			code: "CR-101",
		});
	});

	test("ignores $help without the owner token", () => {
		expect(parseTrigger("$help", OPTIONS)).toEqual({ kind: "ignore" });
	});

	test("returns ignore when the owner token is missing", () => {
		expect(parseTrigger(`$review ${GITHUB_URL}`, OPTIONS)).toEqual({
			kind: "ignore",
		});
	});

	test("returns ignore when neither $review nor $thrash is present", () => {
		expect(parseTrigger(`!owner ${GITHUB_URL}`, OPTIONS)).toEqual({
			kind: "ignore",
		});
	});

	test("returns ignore before any error check when the owner token is missing", () => {
		expect(parseTrigger("$review ~spice 9", OPTIONS)).toEqual({
			kind: "ignore",
		});
	});

	test("returns CR-101 when no PR link is present", () => {
		expect(parseTrigger("!owner $review", OPTIONS)).toEqual({
			kind: "error",
			code: "CR-101",
		});
	});

	test("returns CR-101 when the only link is not a PR or MR path", () => {
		expect(
			parseTrigger("!owner $review https://github.com/o/r/issues/3", OPTIONS),
		).toEqual({ kind: "error", code: "CR-101" });
	});

	test.each(["7", "0", "6", "abc", "2.5"])(
		"returns CR-102 for ~spice %s",
		(value) => {
			expect(
				parseTrigger(`!owner $review ${GITHUB_URL} ~spice ${value}`, OPTIONS),
			).toEqual({ kind: "error", code: "CR-102" });
		},
	);

	test.each([1, 5])("accepts boundary ~spice %d", (value) => {
		expect(
			parseTrigger(`!owner $review ${GITHUB_URL} ~spice ${value}`, OPTIONS),
		).toMatchObject({ kind: "run", spice: value });
	});

	test("returns CR-103 for an unknown agent", () => {
		expect(
			parseTrigger(`!owner $review ${GITHUB_URL} ~agent gemini`, OPTIONS),
		).toEqual({ kind: "error", code: "CR-103" });
	});

	test.each(["claude", "codex", "copilot", "grok"])("accepts ~agent %s", (agent) => {
		expect(
			parseTrigger(`!owner $review ${GITHUB_URL} ~agent ${agent}`, OPTIONS),
		).toMatchObject({ kind: "run", agent });
	});

	test("returns stacked true only when ~stacked is present", () => {
		const base = `!owner $review ${GITHUB_URL}`;
		expect(parseTrigger(base, OPTIONS)).toMatchObject({ stacked: false });
		expect(parseTrigger(`${base} ~stacked`, OPTIONS)).toMatchObject({
			stacked: true,
		});
	});

	test("returns fun true only when ~fun is present", () => {
		const base = `!owner $review ${GITHUB_URL}`;
		expect(parseTrigger(base, OPTIONS)).toMatchObject({ fun: false });
		expect(parseTrigger(`${base} ~fun`, OPTIONS)).toMatchObject({ fun: true });
	});

	test("returns comment false when ~comment is absent", () => {
		expect(parseTrigger(`!owner $review ${GITHUB_URL}`, OPTIONS)).toMatchObject(
			{ comment: false },
		);
	});

	test("recognizes a GitLab merge request link", () => {
		expect(parseTrigger(`!owner $review ${GITLAB_URL}`, OPTIONS)).toMatchObject(
			{ kind: "run", host: "gitlab", url: GITLAB_URL, number: 5 },
		);
	});

	test("uses the first URL whose path is a PR or MR", () => {
		const text = `!owner $review https://github.com/o/r/issues/3 ${GITHUB_URL} ${GITLAB_URL}`;
		expect(parseTrigger(text, OPTIONS)).toMatchObject({
			url: GITHUB_URL,
			host: "github",
		});
	});

	test("returns the canonical url with host lowercased and path, query and fragment cut", () => {
		const text = `!owner $review https://GitHub.com/o/r/pull/12/files?x=1#frag`;
		expect(parseTrigger(text, OPTIONS)).toMatchObject({
			url: prKey("https://GitHub.com/o/r/pull/12/files?x=1#frag"),
		});
		expect(parseTrigger(text, OPTIONS)).toMatchObject({ url: GITHUB_URL });
	});

	test("decodes &nbsp; between tokens", () => {
		const text = `<p>!owner&nbsp;$review&nbsp;${GITHUB_URL}&nbsp;~spice&nbsp;2</p>`;
		expect(parseTrigger(text, OPTIONS)).toMatchObject({
			kind: "run",
			url: GITHUB_URL,
			spice: 2,
		});
	});

	test("decodes &amp; inside an href and still yields the canonical url without a query", () => {
		const text = `!owner $review <a href="${GITHUB_URL}?a=1&amp;b=2">PR</a>`;
		const result = parseTrigger(text, OPTIONS);
		expect(result).toMatchObject({ kind: "run", url: GITHUB_URL });
		expect(JSON.stringify(result)).not.toContain("&amp;");
	});

	test("keeps an href value when the anchor text is not a URL", () => {
		const text = `!owner $review <a href="${GITLAB_URL}">open it</a>`;
		expect(parseTrigger(text, OPTIONS)).toMatchObject({
			url: GITLAB_URL,
			host: "gitlab",
		});
	});
});

describe("parsePrUrl canonical paths", () => {
	test("rejects a path that mixes the GitLab and GitHub shapes", () => {
		expect(
			parsePrUrl("https://github.com/o/-/merge_requests/5/pull/1", HOSTS),
		).toBeUndefined();
		expect(
			parsePrUrl("https://gitlab.com/o/-/merge_requests/5/pull/1", HOSTS),
		).toBeUndefined();
	});

	test("rejects a path segment outside letters, digits, dot, underscore, and hyphen", () => {
		expect(
			parsePrUrl("https://github.com/o/r%20x/pull/1", HOSTS),
		).toBeUndefined();
		expect(
			parsePrUrl("https://github.com/o/r$x/pull/1", HOSTS),
		).toBeUndefined();
		expect(
			parsePrUrl("https://gitlab.com/g/p!x/-/merge_requests/1", HOSTS),
		).toBeUndefined();
	});

	test("rejects a GitHub path with extra prefix segments", () => {
		expect(
			parsePrUrl("https://github.com/x/o/r/pull/1", HOSTS),
		).toBeUndefined();
	});

	test("keeps the nested group path of a GitLab merge request", () => {
		expect(
			parsePrUrl("https://gitlab.com/a/b/c/-/merge_requests/7/diffs", HOSTS),
		).toEqual({
			url: "https://gitlab.com/a/b/c/-/merge_requests/7",
			host: "gitlab",
			number: 7,
		});
	});
});

describe("parseTrigger with a quoted request", () => {
	const quote = (inner: string) =>
		`<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="m1"><p itemprop="copy">${inner}</p></blockquote>`;

	test("ignores a command that appears only inside the quote", () => {
		expect(
			parseTrigger(`${quote(`!owner $review ${GITHUB_URL}`)}<p>thanks</p>`, OPTIONS),
		).toEqual({ kind: "ignore" });
	});

	test("does not take a linked target from a quoted request for an outside command", () => {
		const html = `${quote(`<a href = "${GITHUB_URL}">Fix records…</a>`)}<p>!owner $review</p>`;
		expect(parseTrigger(html, OPTIONS)).toEqual({ kind: "error", code: "CR-101" });
	});

	test("runs a command written outside the quote", () => {
		expect(
			parseTrigger(`${quote("old note")}<p>!owner $review ${GITHUB_URL}</p>`, OPTIONS),
		).toMatchObject({ kind: "run", url: GITHUB_URL });
	});
});

describe("parseReadiness", () => {
	const options = { phrases: PHRASES, blockedMessages: {}, hosts: HOSTS };
	const NO_PHRASE = { kind: "ignore", reason: "no-phrase" } as const;
	const NO_LINK = { kind: "ignore", reason: "no-link" } as const;

	const quoteHtml = (id: string, copy: string) =>
		`<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${id}"><strong itemprop="mri" itemid="8:orgid:abc">Dana</strong><span itemprop="time" itemid="${id}"></span><p itemprop="copy">${copy}</p></blockquote>`;
	const quotedReply = (id: string, url: string) =>
		`${quoteHtml(id, `$review ${url}`)}<p><at id="0">Review Bot</at> ready</p>`;

	test("returns rereview for a phrase plus a url with no mention", () => {
		expect(parseReadiness(`ptal ${GITHUB_URL}`, options)).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
		});
	});

	test("returns rereview for a url that is not blocked", () => {
		expect(
			parseReadiness(`ptal ${GITHUB_URL}`, {
				...options,
				blockedMessages: { m1: GITLAB_URL },
			}),
		).toEqual({ kind: "rereview", url: GITHUB_URL });
	});

	test("ignores a url with no readiness phrase", () => {
		expect(parseReadiness(GITHUB_URL, options)).toEqual(NO_PHRASE);
	});

	test("ignores 'already' because ready must match on a word boundary", () => {
		expect(parseReadiness(`already ${GITHUB_URL}`, options)).toEqual(NO_PHRASE);
	});

	test("matches the multi-word phrase 'good to go'", () => {
		expect(parseReadiness(`good to go ${GITHUB_URL}`, options)).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
		});
	});

	test("matches phrases case-insensitively", () => {
		expect(parseReadiness(`READY ${GITHUB_URL}`, options)).toMatchObject({
			kind: "rereview",
		});
	});

	test("ignores 'ready' that appears only inside a URL path", () => {
		expect(
			parseReadiness("look at https://github.com/o/ready-app/pull/12", options),
		).toEqual(NO_PHRASE);
	});

	test("canonicalizes a /files suffix", () => {
		expect(parseReadiness(`ptal ${GITHUB_URL}/files`, options)).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
		});
	});

	test("returns the first allowed pull request link", () => {
		expect(
			parseReadiness(`ptal https://github.com/o/r/pull/5 ${GITHUB_URL}`, options),
		).toEqual({ kind: "rereview", url: "https://github.com/o/r/pull/5" });
	});

	test("strips Teams HTML and keeps href values", () => {
		const html = `<p>fixed&nbsp;<a href="${GITHUB_URL}">here</a></p>`;
		expect(parseReadiness(html, options)).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
		});
	});

	test("extracts a titled href with attribute whitespace on a readiness reply", () => {
		const html = `<p>fixed <a href = '${GITHUB_URL}?a=1&amp;b=2'>Fix records (owner's follow-up)…</a></p>`;
		expect(parseReadiness(html, options)).toEqual({ kind: "rereview", url: GITHUB_URL });
	});

	test("extracts a titled href from a reply quote without replaying its command", () => {
		const quote = quoteHtml("m9", `!owner $review <a href = "${GITHUB_URL}">Fix records…</a> ~agent codex`);
		expect(parseTrigger(`${quote}<p>ready</p>`, OPTIONS)).toEqual({ kind: "ignore" });
		expect(parseReadiness(`${quote}<p>ready</p>`, options)).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
			quote,
		});
		expect(parseReadiness(`${quote}<p>thanks</p>`, options)).toEqual(NO_PHRASE);
	});

	test("returns rereview for a quoted reply to the blocked message with no link", () => {
		const html = quotedReply("m1", GITLAB_URL);
		expect(
			parseReadiness(html, { ...options, blockedMessages: { m1: GITHUB_URL } }),
		).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
			quote: quoteHtml("m1", `$review ${GITLAB_URL}`),
		});
	});

	test("takes the link from a quoted request that has no blocked entry", () => {
		expect(parseReadiness(quotedReply("m9", GITHUB_URL), options)).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
			quote: quoteHtml("m9", `$review ${GITHUB_URL}`),
		});
	});

	test("takes the link from a quote of the bot's re-review reply", () => {
		const copy = `Addressed #12 ${GITHUB_URL}. Ready for re-review.`;
		const html = `${quoteHtml("b1", copy)}<p>ptal</p>`;
		expect(parseReadiness(html, options)).toEqual({
			kind: "rereview",
			url: GITHUB_URL,
			quote: quoteHtml("b1", copy),
		});
	});

	test("prefers a link outside the quote over the quote", () => {
		const html = `${quoteHtml("m9", `$review ${GITLAB_URL}`)}<p>ptal ${GITHUB_URL}</p>`;
		expect(parseReadiness(html, options)).toMatchObject({
			kind: "rereview",
			url: GITHUB_URL,
			quote: quoteHtml("m9", `$review ${GITLAB_URL}`),
		});
	});

	test("ignores a quoted reply whose phrase appears only inside the quote", () => {
		const html = `${quoteHtml("m1", `ready ${GITHUB_URL}`)}<p>thanks</p>`;
		expect(
			parseReadiness(html, { ...options, blockedMessages: { m1: GITHUB_URL } }),
		).toEqual(NO_PHRASE);
	});

	test("ignores a phrase with no link anywhere", () => {
		expect(parseReadiness("ptal", options)).toEqual(NO_LINK);
		expect(
			parseReadiness(`${quoteHtml("m9", "$review please")}<p>ready</p>`, options),
		).toEqual(NO_LINK);
	});

	test("honors the phrase list it is given", () => {
		expect(
			parseReadiness(`ptal ${GITHUB_URL}`, { ...options, phrases: ["shipit"] }),
		).toEqual(NO_PHRASE);
	});
});

describe("parsePrUrl", () => {
	test("strips trailing punctuation before parsing", () => {
		expect(parsePrUrl(`${GITHUB_URL}.`, HOSTS)).toEqual({
			url: prKey(GITHUB_URL),
			host: "github",
			number: 12,
		});
	});

	test.each([["https://github.com/o/r/issues/12"], ["not a url"]])(
		"returns undefined for %s",
		(raw) => {
			expect(parsePrUrl(raw, HOSTS)).toBeUndefined();
		},
	);

	test("returns host gitlab and the canonical url for a diffs link with query and fragment", () => {
		const result = parsePrUrl(`${GITLAB_URL}/diffs?x=1#n`, HOSTS);
		expect(result).toEqual({
			url: prKey(GITLAB_URL),
			host: "gitlab",
			number: 5,
		});
	});
});

describe("host allowlist", () => {
	const ENTERPRISE = {
		github: ["ghe.corp.example"],
		gitlab: ["git.corp.example"],
	};
	const GHE_URL = "https://ghe.corp.example/o/r/pull/7";
	const SELF_HOSTED_URL = "https://git.corp.example/g/p/-/merge_requests/9";

	test.each([
		["an unlisted host", "https://evil.example/a/b/-/merge_requests/1"],
		["an unlisted GitHub-shaped host", "https://evil.example/o/r/pull/1"],
		["plain http", "http://github.com/o/r/pull/1"],
		["a username", "https://user@github.com/o/r/pull/1"],
		["a password", "https://user:secret@gitlab.com/g/p/-/merge_requests/1"],
		["a lookalike suffix", "https://github.com.evil.example/o/r/pull/1"],
		["a custom port", "https://github.com:8443/o/r/pull/1"],
		["a GitHub path on a GitLab host", "https://gitlab.com/o/r/pull/1"],
		[
			"a GitLab path on a GitHub host",
			"https://github.com/g/p/-/merge_requests/1",
		],
	])("gives CR-104 for %s", (_label, url) => {
		expect(parseTrigger(`!owner $review ${url}`, OPTIONS)).toEqual({
			kind: "error",
			code: "CR-104",
		});
		expect(
			parseTrigger(`!owner $review <a href = "${url}">Fix records…</a>`, OPTIONS),
		).toEqual({ kind: "error", code: "CR-104" });
		expect(
			parseReadiness(`ready <a href = "${url}">Fix records…</a>`, {
				phrases: PHRASES,
				blockedMessages: {},
				hosts: HOSTS,
			}),
		).toEqual({ kind: "ignore", reason: "no-link" });
		expect(parsePrUrl(url, HOSTS)).toBeUndefined();
	});

	test("accepts a rejected link next to an allowed one", () => {
		expect(
			parseTrigger(
				`!owner $review https://evil.example/o/r/pull/1 ${GITHUB_URL}`,
				OPTIONS,
			),
		).toMatchObject({ kind: "run", url: GITHUB_URL });
	});

	test("accepts configured Enterprise and self-hosted hosts under their own provider", () => {
		expect(parsePrUrl(GHE_URL, ENTERPRISE)).toMatchObject({
			host: "github",
			number: 7,
		});
		expect(parsePrUrl(SELF_HOSTED_URL, ENTERPRISE)).toMatchObject({
			host: "gitlab",
			number: 9,
		});
		expect(
			parsePrUrl("https://ghe.corp.example/g/p/-/merge_requests/1", ENTERPRISE),
		).toBeUndefined();
		expect(
			parsePrUrl("https://git.corp.example/o/r/pull/1", ENTERPRISE),
		).toBeUndefined();
	});

	test("matches hosts case-insensitively", () => {
		expect(parsePrUrl("https://GitHub.com/o/r/pull/1", HOSTS)).toMatchObject({
			host: "github",
		});
	});

	test("parseReadiness ignores a link on a host that is not allowlisted", () => {
		expect(
			parseReadiness(`ready ${GHE_URL}`, {
				phrases: PHRASES,
				blockedMessages: {},
				hosts: HOSTS,
			}),
		).toEqual({ kind: "ignore", reason: "no-link" });
		expect(
			parseReadiness(`ready ${GHE_URL}`, {
				phrases: PHRASES,
				blockedMessages: {},
				hosts: ENTERPRISE,
			}),
		).toMatchObject({ kind: "rereview" });
	});
});
