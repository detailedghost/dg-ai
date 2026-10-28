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
#proto-root[data-width="mobile"] section[data-variant]{max-width:390px;}
#proto-root[data-width="tablet"] section[data-variant]{max-width:768px;}
#proto-root[data-width="desktop"] section[data-variant]{max-width:1440px;}
#protobar{
  --pk-surface:#ffffff;--pk-surface-2:#fafaf8;--pk-fg:#18181b;--pk-mut:#5f5f66;--pk-line:#cfcfc8;--pk-acc:#0f766e;--pk-acc-soft:#e6f4f2;
  --pk-ok:#15803d;--pk-ok-soft:#e8f6ec;--pk-bad:#dc2626;--pk-bad-soft:#fdecec;--pk-note:#a16207;--pk-note-soft:#fef6c7;
  position:fixed;left:50%;bottom:1.1rem;transform:translateX(-50%);z-index:90;max-width:calc(100vw - 2rem);padding:6px;
  background:var(--pk-surface);color:var(--pk-fg);border:1px solid var(--pk-line);border-radius:10px;box-shadow:0 8px 24px rgb(15 23 42/.18);font-size:13px;}
html[data-theme="dark"] #protobar{
  --pk-surface:#1b1b1e;--pk-surface-2:#202024;--pk-fg:#f4f4f5;--pk-mut:#a1a1aa;--pk-line:#3f3f46;--pk-acc:#2dd4bf;--pk-acc-soft:#123430;
  --pk-ok:#4ade80;--pk-ok-soft:#14301f;--pk-bad:#f87171;--pk-bad-soft:#3a1616;--pk-note:#facc15;--pk-note-soft:#36310f;}
#protobar[data-verdict="approved"]{border-color:var(--pk-ok);}
#protobar[data-verdict="approvedNote"]{border-color:var(--pk-note);}
#protobar[data-verdict="changes"]{border-color:var(--pk-bad);}
.pk-bar{display:flex;align-items:center;gap:4px;justify-content:center;}
#protobar .ic{width:38px;height:38px;padding:0;display:inline-grid;place-items:center;border:1px solid transparent;border-radius:8px;
  background:transparent;color:var(--pk-mut);cursor:pointer;position:relative;font:inherit;}
#protobar .ic:hover{background:var(--pk-surface-2);color:var(--pk-fg);}
#protobar .ic:disabled{opacity:.35;cursor:default;background:none;}
#protobar .pk-approve{color:var(--pk-ok);border-color:var(--pk-ok);background:var(--pk-ok-soft);}
#protobar .pk-approve.with-note{color:var(--pk-note);border-color:var(--pk-note);background:var(--pk-note-soft);}
#protobar .pk-reject{color:var(--pk-bad);border-color:var(--pk-bad);background:var(--pk-bad-soft);}
#protobar .pk-note[aria-pressed="true"]{background:var(--pk-acc-soft);color:var(--pk-acc);border-color:var(--pk-acc);}
#protobar .pk-note.has-note::after{content:"";position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:var(--pk-note);box-shadow:0 0 0 2px var(--pk-surface);}
#protobar.is-working{border-color:transparent;background:linear-gradient(var(--pk-surface),var(--pk-surface)) padding-box,
  conic-gradient(from var(--pk-spin),var(--pk-acc),transparent 35%,transparent 65%,var(--pk-acc)) border-box;animation:pk-ring 1.6s linear infinite;}
@property --pk-spin{syntax:"<angle>";inherits:false;initial-value:0deg;}
@keyframes pk-ring{to{--pk-spin:360deg;}}
.pk-sep{width:1px;height:22px;background:var(--pk-line);margin:0 4px;}
#proto-label{padding:0 6px;color:var(--pk-fg);white-space:nowrap;font-weight:600;}
.pk-menu-wrap{position:relative;}
.pk-menu{position:absolute;bottom:calc(100% + 8px);left:0;min-width:170px;padding:4px;background:var(--pk-surface);border:1px solid var(--pk-line);
  border-radius:10px;box-shadow:0 10px 30px rgb(0 0 0/.18);display:grid;gap:2px;z-index:10;}
.pk-menu[hidden]{display:none;}
.pk-menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:7px;background:none;
  font:inherit;font-size:13px;font-weight:550;text-align:left;color:var(--pk-fg);cursor:pointer;}
.pk-menu button span{display:inline-grid;color:var(--pk-mut);}
.pk-menu button:hover,.pk-menu button:focus-visible{background:var(--pk-surface-2);}
.pk-menu button[aria-checked="true"]{background:var(--pk-acc-soft);color:var(--pk-acc);}
.pk-menu button[aria-checked="true"] span{color:var(--pk-acc);}
#proto-notes-panel{padding:4px 4px 8px;}
#proto-notes-panel[hidden]{display:none;}
#proto-notes{width:100%;min-width:min(520px,80vw);min-height:4.5rem;resize:vertical;font:inherit;font-size:13px;padding:9px 11px;border-radius:8px;
  border:1px solid var(--pk-line);background:var(--pk-surface);color:var(--pk-fg);}
#protobar:has(.pk-approve.with-note) #proto-notes{border-color:var(--pk-note);background:var(--pk-note-soft);}
#proto-reject-chips{display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.5rem;}
.proto-chip{font-size:0.75rem;padding:0.3rem 0.6rem;border-radius:999px;border:1px solid var(--pk-line);background:var(--pk-surface-2);color:var(--pk-fg);cursor:pointer;}
#proto-toast{position:fixed;left:50%;bottom:84px;transform:translate(-50%,6px);max-width:min(60ch,calc(100vw - 32px));padding:10px 14px;
  background:#fff;color:#18181b;border:1px solid #cfcfc8;border-radius:10px;box-shadow:0 8px 24px rgb(15 23 42/.18);font-size:13px;
  opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:95;}
html[data-theme="dark"] #proto-toast{background:#1b1b1e;color:#f4f4f5;border-color:#3f3f46;}
#proto-toast.show{opacity:1;transform:translate(-50%,0);}
@keyframes proto-burst{0%{transform:translate(0,0) rotate(0);opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot));opacity:0}}
.proto-confetti{position:fixed;top:38vh;left:50%;width:10px;height:14px;border-radius:2px;pointer-events:none;z-index:96;animation:proto-burst .9s ease-out forwards;}
@media (max-width:760px){#protobar{width:calc(100vw - 2rem);}.pk-bar{flex-wrap:wrap;}#proto-notes{min-width:0;}}
@media (prefers-reduced-motion:reduce){#protobar,#protobar *{animation:none!important;transition:none!important;}}
</style>
</head>
<body>
<div id="proto-root">
${sections}
</div>
<div id="protobar" role="toolbar" aria-label="Prototype decision">
  <div id="proto-notes-panel" hidden>
    <textarea id="proto-notes" aria-label="Note" placeholder="Note: optional for Approve, required for Reject. What should change?"></textarea>
    <div id="proto-reject-chips">${reasonChips}</div>
  </div>
  <div class="pk-bar">
    <button type="button" id="proto-mode" class="ic" data-icon="moon" title="Dark mode" aria-label="Dark mode"></button>
    <div class="pk-menu-wrap">
      <button type="button" id="proto-width" class="ic" data-icon="all" aria-haspopup="menu" aria-expanded="false" aria-controls="proto-width-menu" title="Width: all" aria-label="Width: all"></button>
      <div id="proto-width-menu" class="pk-menu" role="menu" aria-label="Preview width" hidden>
        <button type="button" role="menuitemradio" data-w="all" aria-checked="true"><span data-icon="all"></span>All widths</button>
        <button type="button" role="menuitemradio" data-w="mobile" aria-checked="false"><span data-icon="phone"></span>Mobile</button>
        <button type="button" role="menuitemradio" data-w="tablet" aria-checked="false"><span data-icon="tablet"></span>Tablet</button>
        <button type="button" role="menuitemradio" data-w="desktop" aria-checked="false"><span data-icon="monitor"></span>Desktop</button>
      </div>
    </div>
    <span class="pk-sep" aria-hidden="true"></span>
    <button type="button" id="proto-prev" class="ic" data-icon="left" title="Previous variant (←)" aria-label="Previous variant"></button>
    <span id="proto-label"></span>
    <button type="button" id="proto-next" class="ic" data-icon="right" title="Next variant (→)" aria-label="Next variant"></button>
    <span class="pk-sep" aria-hidden="true"></span>
    <button type="button" id="proto-notes-toggle" class="ic pk-note" data-icon="note" aria-pressed="false" aria-controls="proto-notes-panel" title="Note" aria-label="Note"></button>
    <button type="button" id="proto-approve" class="ic pk-approve" data-icon="check" title="Approve" aria-label="Approve"></button>
    <button type="button" id="proto-reject" class="ic pk-reject" data-icon="rework" title="Reject (note required)" aria-label="Reject"></button>
  </div>
</div>
<div id="proto-toast" role="status" aria-live="polite"></div>
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

  var bar = document.getElementById('protobar');
  var notesPanel = document.getElementById('proto-notes-panel');
  var notesArea = document.getElementById('proto-notes');
  var notesToggle = document.getElementById('proto-notes-toggle');
  var approveBtn = document.getElementById('proto-approve');
  var modeBtn = document.getElementById('proto-mode');
  var widthBtn = document.getElementById('proto-width');
  var widthMenu = document.getElementById('proto-width-menu');
  var WIDTH_ICONS = { all: 'all', mobile: 'phone', tablet: 'tablet', desktop: 'monitor' };
  var WIDTH_NAMES = { all: 'all', mobile: 'mobile 390', tablet: 'tablet 768', desktop: 'desktop 1440' };
  var TEXT_ICONS = { sun: '☀', moon: '☾', all: '▦', phone: '▯', tablet: '▭', monitor: '▬', left: '‹', right: '›', note: '✎', check: '✓', rework: '⟳' };

  function setIcon(node, name){
    node.setAttribute('data-icon', name);
    if (window.dgIcons) node.innerHTML = window.dgIcons.svg(name);
    else node.textContent = TEXT_ICONS[name] || '';
  }
  document.querySelectorAll('#protobar [data-icon]').forEach(function(node){ setIcon(node, node.getAttribute('data-icon')); });

  var toastEl = document.getElementById('proto-toast');
  var toastTimer = null;
  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 4000);
  }

  var CONFETTI = ['#22c55e', '#4c8dff', '#a855f7', '#f59e0b', '#f43f5e', '#14b8a6'];
  function confetti(){
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (var i = 0; i < 28; i++) {
      var angle = (2 * Math.PI * i) / 28 + (i % 3) * 0.12;
      var dist = 160 + (i % 5) * 44;
      var bit = document.createElement('div');
      bit.className = 'proto-confetti';
      bit.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      bit.style.setProperty('--dy', Math.sin(angle) * dist - 40 + 'px');
      bit.style.setProperty('--rot', i * 47 + 'deg');
      bit.style.background = CONFETTI[i % CONFETTI.length];
      bit.style.animationDelay = (i % 6) * 0.03 + 's';
      document.body.appendChild(bit);
      setTimeout(function(node){ node.remove(); }, 1200, bit);
    }
  }

  function setParam(key, value){
    var url = new URL(window.location.href);
    url.searchParams.set(key, value);
    history.replaceState(null, '', url);
  }
  function applyMode(mode){
    document.documentElement.setAttribute('data-theme', mode);
    setIcon(modeBtn, mode === 'dark' ? 'sun' : 'moon');
    var label = mode === 'dark' ? 'Light mode' : 'Dark mode';
    modeBtn.title = label;
    modeBtn.setAttribute('aria-label', label);
  }
  var startMode = new URL(window.location.href).searchParams.get('mode');
  applyMode(startMode === 'dark' || startMode === 'light' ? startMode
    : (document.documentElement.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')));
  modeBtn.addEventListener('click', function(){
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyMode(next);
    setParam('mode', next);
  });

  var widthItems = Array.prototype.slice.call(widthMenu.querySelectorAll('[role="menuitemradio"]'));
  function applyWidth(w){
    if (!WIDTH_ICONS[w]) w = 'all';
    root.setAttribute('data-width', w);
    setIcon(widthBtn, WIDTH_ICONS[w]);
    widthBtn.title = 'Width: ' + WIDTH_NAMES[w];
    widthBtn.setAttribute('aria-label', 'Width: ' + WIDTH_NAMES[w]);
    widthItems.forEach(function(item){ item.setAttribute('aria-checked', String(item.getAttribute('data-w') === w)); });
  }
  function openMenu(open){
    widthMenu.hidden = !open;
    widthBtn.setAttribute('aria-expanded', String(open));
    if (open) (widthMenu.querySelector('[aria-checked="true"]') || widthItems[0]).focus();
  }
  applyWidth(new URL(window.location.href).searchParams.get('width') || 'all');
  widthBtn.addEventListener('click', function(){ openMenu(widthMenu.hidden); });
  widthItems.forEach(function(item){
    item.addEventListener('click', function(){
      var w = item.getAttribute('data-w');
      applyWidth(w);
      setParam('width', w);
      openMenu(false);
      widthBtn.focus();
    });
  });
  widthMenu.addEventListener('keydown', function(e){
    var i = widthItems.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      widthItems[(i + (e.key === 'ArrowDown' ? 1 : -1) + widthItems.length) % widthItems.length].focus();
    }
    if (e.key === 'Escape') { openMenu(false); widthBtn.focus(); }
  });
  document.addEventListener('click', function(e){
    if (!widthMenu.hidden && !e.target.closest('.pk-menu-wrap')) openMenu(false);
  });

  function syncNote(){
    var has = notesArea.value.trim().length > 0;
    notesToggle.classList.toggle('has-note', has);
    approveBtn.classList.toggle('with-note', has);
    approveBtn.title = has ? 'Approve + note' : 'Approve';
    approveBtn.setAttribute('aria-label', approveBtn.title);
  }
  function showNotes(open){
    notesPanel.hidden = !open;
    notesToggle.setAttribute('aria-pressed', String(open));
    if (open) notesArea.focus();
  }
  notesToggle.addEventListener('click', function(){ showNotes(notesPanel.hidden); });
  notesArea.addEventListener('input', syncNote);
  document.querySelectorAll('#proto-reject-chips .proto-chip').forEach(function(chip){
    chip.addEventListener('click', function(){
      var reason = chip.getAttribute('data-reason') || '';
      notesArea.value = notesArea.value ? (notesArea.value + '; ' + reason) : reason;
      showNotes(true);
      syncNote();
    });
  });

  function decided(key){
    bar.setAttribute('data-verdict', key);
    if (key !== 'approved') bar.classList.add('is-working');
  }
  approveBtn.addEventListener('click', function(){
    var notes = notesArea.value.trim();
    window.prototypeDecide('confirm', current, notes);
    decided(notes ? 'approvedNote' : 'approved');
    if (!notes) confetti();
    toast(notes ? 'Approved ' + current + '. Your note starts the next round.' : 'Approved ' + current + '.');
  });
  document.getElementById('proto-reject').addEventListener('click', function(){
    var notes = notesArea.value.trim();
    if (!notes) {
      showNotes(true);
      toast('Add a note first. A rework needs direction.');
      return;
    }
    window.prototypeDecide('reject', '', '[was viewing ' + current + '] ' + notes);
    decided('changes');
    toast('Sent back for rework.');
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
