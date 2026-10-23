import { escapeHtml, validateProtoPlan } from "@dg/common";
import { scriptSafeJson } from "./inject";

export interface Variant {
	key: string;
	html: string;
}

export interface ManifestData {
	name: string;
	chain: string;
	title?: string;
	theme: "light" | "dark" | "auto";
	data: Record<string, string>;
	labels: Record<string, string>;
	rejectReasons: string[];
	variants: Variant[];
}

const KNOWN_FRONTMATTER_KEYS = new Set([
	"name",
	"chain",
	"title",
	"theme",
	"data",
	"labels",
	"reject_reasons",
]);

export const DEFAULT_REJECT_REASONS = [
	"Wrong direction entirely",
	"Too similar to current",
	"Style/branding mismatch",
	"Needs different content",
];

function stripQuotes(s: string): string {
	const t = s.trim();
	if (
		t.length >= 2 &&
		((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))
	) {
		return t.slice(1, -1);
	}
	return t;
}

function parseFrontmatter(lines: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentKey: string | null = null;
	let nestedMap: Record<string, string> | null = null;
	let nestedList: string[] | null = null;

	const flushNested = () => {
		if (currentKey && nestedMap) result[currentKey] = nestedMap;
		if (currentKey && nestedList) result[currentKey] = nestedList;
		nestedMap = null;
		nestedList = null;
		currentKey = null;
	};

	for (const raw of lines) {
		if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
		const isIndented = /^\s/.test(raw);

		if (isIndented && currentKey) {
			const trimmed = raw.trim();
			const listMatch = trimmed.match(/^-\s?(.*)$/);
			if (listMatch) {
				nestedList = nestedList ?? [];
				nestedList.push(stripQuotes(listMatch[1]));
				continue;
			}
			const kv = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
			if (kv) {
				nestedMap = nestedMap ?? {};
				nestedMap[kv[1]] = stripQuotes(kv[2]);
			}
			continue;
		}

		flushNested();
		const kv = raw.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
		if (!kv) continue;
		const [, key, valueRaw] = kv;
		const value = valueRaw.trim();
		if (value === "") {
			currentKey = key;
		} else {
			result[key] = stripQuotes(value);
		}
	}
	flushNested();
	return result;
}

function parseVariants(body: string): Variant[] {
	const lines = body.split(/\r?\n/);
	const variants: Variant[] = [];
	let i = 0;
	let sawFence = false;

	while (i < lines.length) {
		const open = lines[i].match(/^:::\s*(\S+)\s*$/);
		if (!open) {
			i++;
			continue;
		}
		sawFence = true;
		const key = open[1];
		i++;
		const htmlLines: string[] = [];
		while (i < lines.length && lines[i].trim() !== ":::") {
			htmlLines.push(lines[i]);
			i++;
		}
		if (i >= lines.length) {
			throw new Error(
				`manifest: variant block "${key}" is missing its closing ":::"`,
			);
		}
		i++;
		const html = htmlLines.join("\n").trim();
		if (html) variants.push({ key, html });
	}

	if (!sawFence) {
		const trimmed = body.trim();
		if (trimmed) variants.push({ key: "A", html: trimmed });
	}
	return variants;
}

function interpolate(text: string, data: Record<string, string>): string {
	let out = text;
	for (const [key, value] of Object.entries(data)) {
		out = out.split(`{{${key}}}`).join(value);
	}
	return out;
}

function stringMap(
	frontmatter: Record<string, unknown>,
	key: string,
): Record<string, string> {
	const value = frontmatter[key];
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`manifest: frontmatter "${key}" must be a key: value map`);
	return value as Record<string, string>;
}

function stringList(
	frontmatter: Record<string, unknown>,
	key: string,
): string[] | undefined {
	const value = frontmatter[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value))
		throw new Error(`manifest: frontmatter "${key}" must be a list`);
	return value as string[];
}

export function parseManifest(raw: string): ManifestData {
	const lines = raw.split(/\r?\n/);
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;

	let frontmatter: Record<string, unknown> = {};
	if (lines[i]?.trim() === "---") {
		i++;
		const fmLines: string[] = [];
		while (i < lines.length && lines[i].trim() !== "---") {
			fmLines.push(lines[i]);
			i++;
		}
		if (i >= lines.length) {
			throw new Error(
				"manifest: unterminated frontmatter (missing closing ---)",
			);
		}
		i++;
		frontmatter = parseFrontmatter(fmLines);
	}

	for (const key of Object.keys(frontmatter)) {
		if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
			process.stderr.write(
				`prototype: warning: ignoring unknown frontmatter key "${key}"\n`,
			);
		}
	}

	const name =
		typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	if (!name) {
		throw new Error('manifest: missing required frontmatter field "name"');
	}

	const chain =
		typeof frontmatter.chain === "string" && frontmatter.chain.trim()
			? frontmatter.chain.trim()
			: name;
	const data = stringMap(frontmatter, "data");
	const labels = stringMap(frontmatter, "labels");
	const rejectReasons =
		stringList(frontmatter, "reject_reasons") ?? DEFAULT_REJECT_REASONS;
	const themeRaw =
		typeof frontmatter.theme === "string" ? frontmatter.theme : "auto";
	const theme: ManifestData["theme"] =
		themeRaw === "light" || themeRaw === "dark" ? themeRaw : "auto";
	const title =
		typeof frontmatter.title === "string"
			? interpolate(frontmatter.title, data)
			: undefined;

	const body = lines.slice(i).join("\n");
	const rawVariants = parseVariants(body);
	if (rawVariants.length === 0) {
		throw new Error(
			"manifest: no variant content found (need at least one ::: block or bare HTML body)",
		);
	}
	const variants = rawVariants.map((v) => ({
		key: v.key,
		html: interpolate(v.html, data),
	}));

	return { name, chain, title, theme, data, labels, rejectReasons, variants };
}

export function render(m: ManifestData): string {
	const title = m.title ?? m.name;
	const themeAttr = m.theme === "auto" ? "" : ` data-theme="${m.theme}"`;
	const sections = m.variants
		.map((v) => `<section data-variant="${escapeHtml(v.key)}">\n${v.html}\n</section>`)
		.join("\n");
	const variantKeys = m.variants.map((v) => v.key);
	const reasonChips = m.rejectReasons
		.map(
			(r) =>
				`<button type="button" class="proto-chip" data-reason="${escapeHtml(r)}">${escapeHtml(r)}</button>`,
		)
		.join("");

	return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{
  color-scheme: light dark;
  --bg:#f7f7f8; --fg:#1a1a1e; --muted:#6b7280; --border:#e2e2e6; --surface:#ffffff;
  --bar-bg:rgba(20,24,31,0.94); --bar-fg:#e8ecf2; --approve:#1f9d55; --reject:#d97706; --accent:#4c8dff;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#0f1115; --fg:#e8ecf2; --muted:#8b93a3; --border:#262a33; --surface:#161a21; }
}
html[data-theme="light"]{ --bg:#f7f7f8; --fg:#1a1a1e; --muted:#6b7280; --border:#e2e2e6; --surface:#ffffff; }
html[data-theme="dark"]{ --bg:#0f1115; --fg:#e8ecf2; --muted:#8b93a3; --border:#262a33; --surface:#161a21; }
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
#proto-root{min-height:100vh;padding:2.5rem 2rem 7rem;}
section[data-variant]{display:none;max-width:960px;margin:0 auto;}
section[data-variant].is-active{display:block;}
#protobar{position:fixed;left:50%;bottom:1.1rem;transform:translateX(-50%);z-index:90;display:flex;align-items:center;
  gap:0.45rem;background:var(--bar-bg);color:var(--bar-fg);border-radius:999px;padding:0.5rem 0.6rem 0.5rem 0.9rem;
  border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 10px 34px rgba(0,0,0,0.42);flex-wrap:wrap;max-width:calc(100vw - 2rem);font-size:0.85rem;}
#protobar button{font:inherit;border:none;border-radius:999px;padding:0.45rem 0.8rem;cursor:pointer;color:inherit;
  transition:transform .14s cubic-bezier(.34,1.56,.64,1),box-shadow .14s ease,filter .14s ease,background .14s ease;}
#protobar button:active{transform:translateY(1px) scale(.97);}
#proto-prev,#proto-next{background:rgba(255,255,255,0.12);color:var(--bar-fg);font-weight:700;padding:0.4rem 0.62rem;}
#proto-prev:hover,#proto-next:hover,#proto-notes-toggle:hover{background:rgba(255,255,255,0.22);transform:translateY(-1px);}
#proto-label{padding:0 0.4rem;color:var(--bar-fg);opacity:0.92;white-space:nowrap;font-weight:600;letter-spacing:.2px;}
.proto-divider{width:1px;height:1.25rem;background:rgba(255,255,255,0.16);margin:0 0.2rem;border-radius:1px;}
#proto-notes-toggle{background:rgba(255,255,255,0.12);}
#proto-notes-toggle.has-notes{box-shadow:0 0 0 2px var(--accent) inset;color:#fff;}
#proto-approve{color:#fff;font-weight:700;letter-spacing:.2px;padding:0.5rem 1.05rem;
  background:linear-gradient(180deg,#2bbd6b,#1f9d55);
  box-shadow:0 2px 10px rgba(31,157,85,.45),inset 0 1px 0 rgba(255,255,255,.28);
  animation:proto-approve-pulse 3.6s ease-in-out infinite;}
#proto-approve:hover{transform:translateY(-2px);filter:brightness(1.08);
  box-shadow:0 7px 22px rgba(31,157,85,.62),inset 0 1px 0 rgba(255,255,255,.34);}
#proto-reject{color:#fff;font-weight:700;letter-spacing:.2px;padding:0.5rem 1.05rem;
  background:linear-gradient(180deg,#f0991f,#d97706);
  box-shadow:0 2px 10px rgba(217,119,6,.4),inset 0 1px 0 rgba(255,255,255,.24);}
#proto-reject:hover{transform:translateY(-2px);filter:brightness(1.08);
  box-shadow:0 7px 22px rgba(217,119,6,.58),inset 0 1px 0 rgba(255,255,255,.3);}
#protobar button:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none;animation:none;filter:none;}
@keyframes proto-approve-pulse{
  0%,100%{box-shadow:0 2px 10px rgba(31,157,85,.42),inset 0 1px 0 rgba(255,255,255,.28);}
  50%{box-shadow:0 3px 13px rgba(43,189,107,.58),inset 0 1px 0 rgba(255,255,255,.32);}
}
@media (prefers-reduced-motion:reduce){
  #proto-approve{animation:none;}
  #protobar button{transition:none;}
}
#proto-notes-panel{position:fixed;left:50%;bottom:4.5rem;transform:translateX(-50%);z-index:91;background:var(--surface);
  color:var(--fg);border:1px solid var(--border);border-radius:12px;padding:0.9rem 1rem;width:min(420px,calc(100vw - 2rem));
  box-shadow:0 8px 30px rgba(0,0,0,0.35);}
#proto-notes-panel[hidden]{display:none;}
#proto-notes{width:100%;min-height:5.5rem;resize:vertical;font:inherit;padding:0.5rem;border-radius:8px;
  border:1px solid var(--border);background:var(--bg);color:var(--fg);}
#proto-reject-chips{display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.5rem;}
.proto-chip{font-size:0.75rem;padding:0.3rem 0.6rem;border-radius:999px;border:1px solid var(--border);
  background:var(--bg);color:var(--fg);cursor:pointer;}
#proto-notes-hint{font-size:0.75rem;color:var(--muted);margin-top:0.4rem;}
</style>
</head>
<body>
<div id="proto-root">
${sections}
</div>
<div id="protobar">
  <button type="button" id="proto-prev" title="Previous variant (←)">←</button>
  <span id="proto-label"></span>
  <button type="button" id="proto-next" title="Next variant (→)">→</button>
  <span class="proto-divider" aria-hidden="true"></span>
  <button type="button" id="proto-notes-toggle" title="Add notes to send with your choice">Notes</button>
  <button type="button" id="proto-approve" title="Keep this variant — notes optional">Approve ✓</button>
  <button type="button" id="proto-reject" title="Discard all and start over — note required">Reject ⟲</button>
</div>
<div id="proto-notes-panel" hidden>
  <textarea id="proto-notes" placeholder="Optional for Approve. Required for Reject — what should change?"></textarea>
  <div id="proto-reject-chips">${reasonChips}</div>
  <div id="proto-notes-hint">Notes ride along with whichever button you click next.</div>
</div>
<script type="application/json" id="prototype-data">${scriptSafeJson({ name: m.name, variants: variantKeys, labels: m.labels })}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('prototype-data').textContent);
  var VARIANTS = data.variants;
  var LABELS = data.labels;

  var root = document.getElementById('proto-root');
  var sections = {};
  VARIANTS.forEach(function(k){ sections[k] = root.querySelector('section[data-variant="' + k + '"]'); });

  function paramVariant(){
    var v = new URL(window.location.href).searchParams.get('variant');
    return (v && sections[v]) ? v : VARIANTS[0];
  }
  var current = paramVariant();

  function label(k){ return LABELS[k] ? (k + ' — ' + LABELS[k]) : k; }

  function show(k){
    if (!sections[k]) return;
    current = k;
    VARIANTS.forEach(function(key){ sections[key].classList.toggle('is-active', key === k); });
    document.getElementById('proto-label').textContent = label(k) + ' (' + (VARIANTS.indexOf(k) + 1) + '/' + VARIANTS.length + ')';
    var url = new URL(window.location.href);
    url.searchParams.set('variant', k);
    history.replaceState(null, '', url);
  }

  function nav(dir){
    var i = VARIANTS.indexOf(current);
    var next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length];
    show(next);
  }

  document.getElementById('proto-prev').addEventListener('click', function(){ nav(-1); });
  document.getElementById('proto-next').addEventListener('click', function(){ nav(1); });

  document.addEventListener('keydown', function(e){
    var el = document.activeElement;
    var tag = el ? el.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
    if (e.key === 'ArrowLeft') nav(-1);
    if (e.key === 'ArrowRight') nav(1);
  });

  var notesPanel = document.getElementById('proto-notes-panel');
  var notesArea = document.getElementById('proto-notes');
  var notesToggle = document.getElementById('proto-notes-toggle');
  function syncNotesGlow(){ notesToggle.classList.toggle('has-notes', notesArea.value.trim().length > 0); }
  notesToggle.addEventListener('click', function(){
    notesPanel.hidden = !notesPanel.hidden;
  });
  notesArea.addEventListener('input', syncNotesGlow);
  document.querySelectorAll('#proto-reject-chips .proto-chip').forEach(function(chip){
    chip.addEventListener('click', function(){
      var reason = chip.getAttribute('data-reason') || '';
      notesArea.value = notesArea.value ? (notesArea.value + '; ' + reason) : reason;
      notesPanel.hidden = false;
      syncNotesGlow();
    });
  });

  document.getElementById('proto-approve').addEventListener('click', function(){
    var notes = notesArea.value.trim();
    window.prototypeDecide('confirm', current, notes);
  });
  document.getElementById('proto-reject').addEventListener('click', function(){
    var notes = notesArea.value.trim();
    if (!notes) {
      notesPanel.hidden = false;
      notesArea.focus();
      notesArea.placeholder = 'Reject requires a note — what should change?';
      return;
    }
    window.prototypeDecide('reject', '', '[was viewing ' + current + '] ' + notes);
  });

  show(current);
})();
</script>
</body>
</html>
`;
}

function planToManifest(raw: string): ManifestData {
	const plan = validateProtoPlan(JSON.parse(raw));
	return {
		name: plan.slug,
		chain: plan.slug,
		title: plan.question?.trim() || plan.slug,
		theme: "auto",
		data: {},
		labels: Object.fromEntries(
			plan.variations.map((variation) => [variation.key, variation.label]),
		),
		rejectReasons: DEFAULT_REJECT_REASONS,
		variants: plan.variations.map((variation) => ({
			key: variation.key,
			html: variation.css
				? `<style>@scope ([data-variant="${variation.key}"]) {\n${variation.css}\n}</style>\n${variation.html}`
				: variation.html,
		})),
	};
}

/** Read either a Markdown manifest or a ProtoPlan JSON document into one render model. */
export function parseManifestSource(raw: string): ManifestData {
	return raw.trimStart().startsWith("{")
		? planToManifest(raw)
		: parseManifest(raw);
}
