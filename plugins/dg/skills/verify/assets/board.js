const $ = (id) => document.getElementById(id);
const marks = { approved: "✓", changes: "✎", skip: "–", more: "+" };
const verdictCls = (v) => (v?.status === "approved" && v.note ? "note" : v?.status || "");
const widthOf = (label) => (label.match(/mobile|tablet|desktop/) || ["other"])[0];
let sections = [];
let pending = [];
let manifestText = "";
let pollTimer = null;
const POLL_MS = 5000;
let verdicts = {};
let index = 0;
let variant = 0;
let variantFor = null;
let pendingVariant = null;
const hasVariants = () => !$("section").hidden && (sections[index]?.variants || []).length > 0;
function stepVariant(d) {
  const vs = sections[index].variants;
  variant = (variant + d + vs.length) % vs.length;
  const note = $("note").value;
  renderSection(true);
  if (!verdicts[sections[index].id]?.status) $("note").value = note;
  syncVerdictUi();
}
let width = matchMedia("(max-width:760px)").matches ? "mobile" : "all";

const revs = {};
const themeOf = (im) => {
  const text = `${im.label || ""} ${im.after || ""}`.toLowerCase();
  return /(^|[^a-z])dark([^a-z]|$)/.test(text) ? "dark" : /(^|[^a-z])light([^a-z]|$)/.test(text) ? "light" : null;
};
const imgSrc = (path) => (path && path !== "missing" ? `${path}${revs[sections[index]?.id] ? `?v=${revs[sections[index].id]}` : ""}` : null);

function figure(caption, path, reason) {
  const fig = document.createElement("figure");
  const cap = document.createElement("figcaption");
  cap.textContent = caption;
  fig.append(cap);
  const src = imgSrc(path);
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = `${caption} screenshot`;
    img.loading = "lazy";
    const zoom = el("button", "zoom-btn");
    zoom.type = "button";
    zoom.setAttribute("aria-label", `Zoom: ${img.alt}`);
    zoom.addEventListener("click", () => openZoom(src, img.alt));
    zoom.append(img);
    fig.append(zoom);
  } else {
    const box = document.createElement("div");
    box.className = "missing";
    box.textContent = reason || "No screenshot";
    fig.append(box);
  }
  return fig;
}

function openZoom(src, alt) {
  $("zoom-img").src = src;
  $("zoom-img").alt = alt;
  $("zoom").showModal();
}

const statusText = (v) => {
  if (!v?.status) return "not reviewed";
  if (v.status === "approved") return `${v.variant ? `picked ${v.variant}` : "approved"}${v.note ? " + note" : ""}`;
  if (v.status === "more") return "more versions";
  return v.status === "changes" ? "sent back" : "skipped";
};

function chains() {
  const roots = sections.filter((s) => !s.follows || !sections.some((x) => x.id === s.follows));
  return roots.map((root) => {
    const rounds = [root];
    for (let next = successorOf(root); next; next = successorOf(next)) rounds.push(next);
    const last = rounds[rounds.length - 1];
    return { rounds, last, waiting: pending.find((p) => p.follows === last.id) };
  });
}

function tocButton(dotCls, dotText, text, label, onClick, current) {
  const b = el("button");
  b.type = "button";
  const dot = el("span", `dot ${dotCls}`, dotText);
  dot.setAttribute("aria-hidden", "true");
  b.append(dot, el("span", "", text));
  b.setAttribute("aria-label", label);
  if (onClick) b.addEventListener("click", onClick);
  else b.disabled = true;
  if (current) b.setAttribute("aria-current", "step");
  return b;
}

const folds = (() => {
  try {
    return JSON.parse(localStorage.getItem("verify-folds") || "{}");
  } catch {
    return {};
  }
})();

function setFold(key, collapsed) {
  folds[key] = collapsed;
  try {
    localStorage.setItem("verify-folds", JSON.stringify(folds));
  } catch {}
}

const needsAttention = (s) => !verdicts[s.id]?.status;

function orb(count) {
  const o = el("span", count ? "orb orb-count" : "orb", count ? String(count) : "");
  o.setAttribute("aria-hidden", "true");
  return o;
}

function goNextAttention() {
  const from = $("section").hidden ? -1 : index;
  const order = [...sections.keys()].map((k) => (from + 1 + k) % sections.length);
  const next = order.find((k) => needsAttention(sections[k]));
  if (next !== undefined) go(next);
}

const CALM_GROUPS = ["#toc .orb:not(.orb-count)", "#toc .dot.working", "#summary .chip.working", "#end li.working"];
function calm() {
  for (const sel of CALM_GROUPS) {
    document.querySelectorAll(sel).forEach((node, i) => node.classList.toggle("calm", i > 0));
  }
}

function renderToc() {
  const toc = $("toc");
  toc.replaceChildren();
  const pinned = el("li", "pinned");
  const overview = el("div", "overview");
  overview.append(tocButton("", "≡", "Overview", "Overview of every item and round", renderSummary, !$("summary").hidden));
  const needs = sections.filter(needsAttention);
  const attn = el("div", "attention");
  const ab = tocButton("", "", needs.length ? "Needs attention" : "All caught up", needs.length ? `Needs attention: ${needs.length} waiting. Go to the next one` : "Nothing needs your attention", attentionClick, false);
  ab.querySelector(".dot").innerHTML = svg("bell");
  ab.classList.toggle("alerts-on", alertsOn());
  ab.classList.toggle("caught-up", !needs.length);
  if (needs.length) ab.append(orb(needs.length));
  attn.append(ab);
  pinned.append(overview, attn);
  toc.append(pinned);
  const showing = $("section").hidden ? null : sections[index];
  for (const chain of chains()) {
    const { rounds, last, waiting } = chain;
    const head = waiting ? null : last;
    const li = el("li");
    const v = head ? verdicts[head.id] : null;
    const headDot = waiting ? "working" : verdictCls(v);
    const headMark = waiting ? "" : (marks[v?.status] || "○");
    const target = rounds.find((r) => !verdicts[r.id]?.status) || last;
    const headBtn = tocButton(headDot, headMark, last.title, `${last.title}: ${waiting ? "agent working" : statusText(v)}${rounds.some(needsAttention) ? ", needs attention" : ""}`, () => go(sections.indexOf(target)), rounds.includes(showing) && rounds.length === 1);
    if (rounds.some(needsAttention)) headBtn.append(orb());
    li.append(headBtn);
    if (rounds.length > 1 || waiting) {
      const key = rounds[0].id;
      const collapsed = folds[key] ?? (!waiting && resolved(last));
      const line = el("ol", "timeline");
      line.id = `tl-${key}`;
      line.hidden = collapsed;
      line.setAttribute("aria-label", `${last.title} rounds`);
      const fold = el("button", "fold", "");
      fold.type = "button";
      fold.setAttribute("aria-expanded", String(!collapsed));
      fold.setAttribute("aria-controls", line.id);
      fold.setAttribute("aria-label", `${collapsed ? "Show" : "Hide"} rounds for ${last.title}`);
      fold.title = `${rounds.length + (waiting ? 1 : 0)} rounds`;
      fold.append(el("span", "count", String(rounds.length + (waiting ? 1 : 0))));
      fold.addEventListener("click", () => {
        setFold(key, !line.hidden);
        renderToc();
      });
      li.classList.add("has-fold");
      li.append(fold);
      const base = rounds[0].round || 1;
      const roundOf = (r, i) => r.round || base + i;
      rounds.forEach((r, i) => {
        const rv = verdicts[r.id];
        const sub = el("li");
        const rb = tocButton(verdictCls(rv), String(roundOf(r, i)), r.summary || shortWhat(r), `${r.title}, round ${roundOf(r, i)}: ${statusText(rv)}`, () => go(sections.indexOf(r)), r === showing);
        if (needsAttention(r)) rb.append(orb());
        sub.append(rb);
        line.append(sub);
      });
      if (waiting) {
        const sub = el("li");
        sub.append(tocButton("working", String(roundOf(last, rounds.length - 1) + 1), waiting.detail || "Agent working", `${last.title}: next round in progress`, null, false));
        line.append(sub);
      }
      li.append(line);
    }
    toc.append(li);
  }
  for (const p of pending.filter((x) => !x.follows)) {
    const li = el("li", "upcoming");
    li.append(tocButton("working", "", p.title, `${p.title}: agent working`, null, false));
    toc.append(li);
  }

  const done = sections.filter((s) => verdicts[s.id]?.status).length;
  $("progress").textContent = `${done} of ${sections.length} rounds reviewed${pending.length ? ` · ${pending.length} in progress` : ""}`;
  $("meter").style.width = sections.length ? `${(done / sections.length) * 100}%` : "0";
  calm();
  updateTab();
}

function renderSection(stay = false) {
  const s = sections[index];
  $("summary").hidden = true;
  $("section").hidden = false;
  const step = document.createElement("span");
  step.className = "pill step";
  step.textContent = `Section ${index + 1} of ${sections.length}`;
  const branch = document.createElement("span");
  branch.className = "pill";
  branch.textContent = s.branch || "bundle";
  $("sec-branch").replaceChildren(step, branch);
  const live = safeUrl(s.stackUrl || stackUrl);
  if (live) {
    const a = el("a", "pill live-link", "Open in app ↗");
    a.href = live;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    $("sec-branch").append(a);
  }
  $("sec-title").textContent = s.title;
  $("sec-what").textContent = s.what_changed || "";
  const checks = [];
  if (s.checks?.tests) checks.push(["Tests", s.checks.tests.summary, s.checks.tests.status]);
  if (s.checks?.axe) {
    const found = s.checks.axe.violations;
    checks.push(["Accessibility", found.length ? found.join(", ") : `${s.checks.axe.passes} rules pass`, found.length ? "failed" : "passed"]);
  }
  $("sec-checks").replaceChildren(...checks.map(([name, text, state]) => {
    const pill = el("span", "pill", `${name}: ${text}`);
    pill.dataset.state = state;
    return pill;
  }));
  $("sec-checks").hidden = !checks.length;
  const vs = s.variants || [];
  const picked = verdicts[s.id]?.variant;
  if (variantFor !== s.id) {
    variantFor = s.id;
    variant = Math.max(0, vs.findIndex((x) => x.key === (pendingVariant || picked)));
    pendingVariant = null;
  }
  const cur = vs[variant];
  $("variants").hidden = !vs.length;
  $("v-more").dataset.versions = vs.length ? "1" : "";
  if (cur) {
    $("v-label").textContent = `${cur.key} · ${cur.label || `Version ${cur.key}`}`;
    $("v-label").title = cur.summary || "";
    $("sec-what").textContent = [s.what_changed, cur.summary && `${cur.key}: ${cur.summary}`].filter(Boolean).join(" ");
  }
  const shots = $("shots");
  shots.replaceChildren();
  const list = (cur ? cur.images : s.images) || [];
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  for (const im of list) {
    const w = widthOf(im.label || "");
    if (width !== "all" && w !== width) continue;
    const t = themeOf(im);
    if ((t || "light") !== theme) continue;
    const card = document.createElement("div");
    card.className = "shot";
    const h = document.createElement("h3");
    h.textContent = im.label;
    const head = el("div", "shot-head");
    head.append(h);
    const pair = document.createElement("div");
    pair.className = `pair w-${w}${im.target ? " has-target" : ""}`;
    const beforeCap = cur ? "Now" : "Before";
    const afterCap = cur ? `Version ${cur.key}` : "After";
    const fb = figure(beforeCap, im.before, im.reason);
    const fa = figure(afterCap, im.after, im.reason);
    pair.append(fb, fa);
    if (im.target) pair.append(figure("Prototype", im.target));
    if (imgSrc(im.before) && imgSrc(im.after)) head.append(viewSwitch(pair, `${s.id}::${im.label}`, beforeCap, afterCap));
    if (highlight && imgSrc(im.before) && imgSrc(im.after)) markChanges(head, fb, fa, imgSrc(im.before), imgSrc(im.after));
    card.append(head, pair, shotNote(s, im.label, head));
    shots.append(card);
  }
  if (!shots.children.length) shots.textContent = list.some((im) => (themeOf(im) || "light") === theme) ? "No screenshots for this width." : `No ${theme} screenshots for this round. Switch the theme to see the ${theme === "dark" ? "light" : "dark"} ones.`;
  const v = verdicts[s.id] || {};
  $("note").value = mainNoteOf(v);
  $("section").dataset.verdict = keyOf(v.status, v.note);
  $("note").dataset.saved = mainNoteOf(v);
  setLocked(Boolean(v.status) && editing !== s.id, v);
  syncVerdictUi();
  $("prev").disabled = index === 0;
  $("prev").hidden = $("next").hidden = Boolean(cur);
  $("prev").nextElementSibling.nextElementSibling.hidden = Boolean(cur);
  history.replaceState(null, "", `${location.search}#${encodeURIComponent(s.id)}${cur ? `:${cur.key}` : ""}`);
  renderToc();
  if (stay) return;
  $("sec-title").focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function item(tagText, tagCls, text) {
  const li = el("li");
  li.append(el("span", `tag ${tagCls}`, tagText), el("span", "", text));
  return li;
}

const shortWhat = (r) => {
  const t = (r.what_changed || r.title).split(/(?<=\.)\s/)[0].replace(/\.$/, "");
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
};

const successorOf = (s) => sections.find((x) => x.follows === s.id);

function resolved(s) {
  const v = verdicts[s.id] || {};
  if (v.status === "approved" && !v.note) return true;
  const next = successorOf(s);
  return next ? resolved(next) : false;
}

const keyOf = (status, note) => (status === "approved" && note ? "approvedNote" : status || "");

const svg = (name) => globalThis.dgIcons.svg(name);
function setIcon(node, name) {
  node.dataset.icon = name;
  node.innerHTML = svg(name);
}
for (const node of document.querySelectorAll("[data-icon]")) node.innerHTML = svg(node.dataset.icon);

const decidedText = { approved: "Approved", approvedNote: "Approved + note", changes: "Sent back", skip: "Skipped", more: "More versions" };

const shotDrafts = {};
let editing = null;
const shotKey = (s, label) => `${s.id}::${label}`;
const mainNoteOf = (v) => (v.mainNote ?? v.note ?? "");

function shotNotesFor(s) {
  const out = {};
  for (const [k, text] of Object.entries(shotDrafts)) {
    if (k.startsWith(`${s.id}::`) && text.trim()) out[k.slice(s.id.length + 2)] = text.trim();
  }
  return out;
}

function shotNote(s, label, head) {
  const key = shotKey(s, label);
  const v = verdicts[s.id] || {};
  if (!(key in shotDrafts)) shotDrafts[key] = v.shotNotes?.[label] || "";
  const wrap = el("div", "shot-note");
  if (v.status && editing !== s.id) {
    if (shotDrafts[key]) wrap.append(el("blockquote", "", shotDrafts[key]));
    else wrap.hidden = true;
    return wrap;
  }
  const btn = el("button", "shot-note-btn");
  btn.type = "button";
  btn.innerHTML = `${svg("note")}<span>Note on this</span>`;
  btn.title = `Note on ${label}`;
  btn.setAttribute("aria-label", `Note on ${label}`);
  const input = el("input");
  input.id = `sn-${btoa(unescape(encodeURIComponent(key))).replace(/[^a-z0-9]/gi, "")}`;
  input.autocomplete = "off";
  input.placeholder = `Note on ${label}`;
  input.setAttribute("aria-label", `Note on ${label}`);
  input.value = shotDrafts[key];
  btn.setAttribute("aria-controls", input.id);
  const sync = () => {
    const has = Boolean(input.value.trim());
    btn.classList.toggle("has-note", has);
    btn.setAttribute("aria-pressed", String(!wrap.hidden));
  };
  wrap.hidden = !input.value;
  input.addEventListener("input", () => {
    shotDrafts[key] = input.value;
    sync();
    syncVerdictUi();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
    if (e.key === "Escape" && !input.value) {
      wrap.hidden = true;
      sync();
      btn.focus();
    }
  });
  btn.addEventListener("click", () => {
    wrap.hidden = !wrap.hidden;
    sync();
    if (!wrap.hidden) input.focus();
  });
  wrap.append(input);
  head.append(btn);
  sync();
  return wrap;
}

function setLocked(locked, v = {}) {
  const key = keyOf(v.status, v.note);
  $("note").readOnly = locked;
  $("note").value = locked ? "" : $("note").dataset.saved || "";
  for (const b of document.querySelectorAll(".pk-approve,.pk-reject,.pk-skip,.pk-note")) b.hidden = locked;
  $("v-more").hidden = locked || !$("v-more").dataset.versions;
  showNote(!locked && Boolean($("note").value));
  $("decided-pill").hidden = !locked;
  $("change").hidden = !locked;
  $("decided-pill").textContent = v.variant && v.status === "approved" ? `${decidedText[key]} · ${v.variant}` : decidedText[key] || "";
  $("decided-pill").className = `pill decided-pill ${key}`;
  const pop = locked && v.note;
  $("note-pop").hidden = !pop;
  if (pop) {
    $("note-pop").className = `note-pop ${key}`;
    $("note-pop-verdict").textContent = decidedText[key];
    $("note-pop-verdict").className = `pill ${key}`;
    $("note-pop-at").textContent = v.at ? new Date(v.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    $("note-pop-text").textContent = mainNoteOf(v) || "Notes on the screenshots below.";
  }
}

function showNote(open) {
  $("note-row").hidden = !open;
  $("note-btn").setAttribute("aria-pressed", String(open));
}

function syncVerdictUi() {
  const note = Boolean($("note").value.trim()) || (sections[index] && Object.keys(shotNotesFor(sections[index])).length > 0);
  const label = note ? "Approve with note (starts a follow-up round)" : "Approve";
  $("approve").title = label;
  $("approve").setAttribute("aria-label", label);
  $("approve").classList.toggle("with-note", note);
  $("note-btn").classList.toggle("has-note", note);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 4000);
}

const CONFETTI = ["#22c55e", "#4c8dff", "#a855f7", "#f59e0b", "#f43f5e", "#14b8a6"];
function confetti() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  for (let i = 0; i < 28; i++) {
    const angle = (2 * Math.PI * i) / 28 + (i % 3) * 0.12;
    const dist = 160 + (i % 5) * 44;
    const bit = el("div", "confetti");
    bit.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    bit.style.setProperty("--dy", `${Math.sin(angle) * dist - 40}px`);
    bit.style.setProperty("--rot", `${i * 47}deg`);
    bit.style.background = CONFETTI[i % CONFETTI.length];
    bit.style.animationDelay = `${(i % 6) * 0.03}s`;
    document.body.append(bit);
    setTimeout(() => bit.remove(), 1200);
  }
}

function renderEnd() {
  const end = $("end");
  end.replaceChildren();
  const open = sections.filter((s) => !successorOf(s) && !pending.some((p) => p.follows === s.id));
  const changes = open.filter((s) => verdicts[s.id]?.status === "changes");
  const moreReq = open.filter((s) => verdicts[s.id]?.status === "more");
  const followUps = open.filter((s) => verdicts[s.id]?.status === "approved" && verdicts[s.id]?.note);
  const skipped = sections.filter((s) => verdicts[s.id]?.status === "skip");
  const allGood = sections.length > 0 && !pending.length && sections.every(resolved);
  if (allGood) {
    end.append(
      el("div", "badge", "✓"),
      el("h2", "", "All approved"),
      el("p", "muted", "Every section is approved and no agent work is outstanding. You can close this tab."),
    );
    const actions = el("div", "actions");
    const close = el("button", "primary", "Close tab");
    close.type = "button";
    close.addEventListener("click", () => window.close());
    actions.append(close);
    end.append(actions);
    return;
  }
  end.append(
    el("div", "spinner"),
    el("h2", "", sections.length ? "Waiting for agents" : "Screenshots are still being captured"),
    el("p", "muted", "This page checks for new results every few seconds and opens the next section when it arrives. Keep this tab open."),
  );
  const list = el("ul");
  for (const p of pending) {
    const li = item("in progress", "", p.title + (p.detail ? ` · ${p.detail}` : ""));
    li.classList.add("working");
    list.append(li);
  }
  for (const s of changes) list.append(item("sent back", "changes", s.title));
  for (const s of moreReq) list.append(item("more versions", "more", s.title));
  for (const s of followUps) list.append(item("follow-up", "", `${s.title} · approved with a note`));
  for (const s of skipped) list.append(item("skipped", "skip", s.title));
  if (list.children.length) end.append(list);
  if (skipped.length) {
    const actions = el("div", "actions");
    const back = el("button", "", "Review skipped");
    back.type = "button";
    back.addEventListener("click", () => go(sections.indexOf(skipped[0])));
    actions.append(back);
    end.append(actions);
  }
  const stamp = el("p", "muted poll", "");
  stamp.id = "poll-stamp";
  end.append(stamp);
  calm();
  startPoll();
}

function chainState(chain) {
  if (chain.waiting) return "In progress";
  const v = verdicts[chain.last.id];
  if (!v?.status) return "Needs review";
  if (v.status === "skip") return "Skipped";
  if (v.status === "changes" || v.status === "more" || v.note) return "Waiting on agent";
  return "Done";
}

function renderSummary() {
  history.replaceState(null, "", `${location.search}#overview`);
  $("section").hidden = true;
  $("summary").hidden = false;
  const body = $("sum-body");
  body.replaceChildren();
  const heads = [...document.querySelectorAll("#summary thead th")].map((th) => th.textContent);
  const row = (cells) => {
    const tr = el("tr");
    for (const [i, cell] of cells.entries()) {
      const td = el("td");
      td.dataset.label = heads[i] || "";
      td.append(cell);
      tr.append(td);
    }
    body.append(tr);
  };
  const chip = (n, cls, mark, label) => {
    const c = el("span", `chip ${cls}`);
    c.append(el("span", "num", String(n)), el("span", "mark", mark));
    c.title = label;
    c.setAttribute("aria-label", `Round ${n}: ${label}`);
    return c;
  };
  const roundsCell = (items) => {
    const wrap = el("span", "chips");
    items.forEach((it, i) => {
      if (i) wrap.append(el("span", "arrow", "→"));
      wrap.append(it);
    });
    return wrap;
  };
  for (const chain of chains()) {
    const base = chain.rounds[0].round || 1;
    const steps = chain.rounds.map((r, i) => {
      const v = verdicts[r.id];
      return chip(r.round || base + i, verdictCls(v), (marks[v?.status] || "") + (v?.note && v.status === "approved" ? " note" : ""), statusText(v));
    });
    if (chain.waiting) steps.push(chip((chain.last.round || base + chain.rounds.length - 1) + 1, "working", "working", "agent working"));
    const note = [...chain.rounds].reverse().map((r) => verdicts[r.id]?.note).find(Boolean) || "";
    row([chain.last.title, roundsCell(steps), chainState(chain), note]);
  }
  for (const p of pending.filter((x) => !x.follows)) row([p.title, roundsCell([chip(1, "working", "working", "agent working")]), "In progress", p.detail || ""]);
  renderEnd();
  renderToc();
}

const firstUnreviewed = () => sections.findIndex((s) => !verdicts[s.id]?.status);

let stackUrl = "";
const safeUrl = (u) => {
  if (!u) return "";
  try {
    const url = new URL(u, location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};

function applyManifest(text) {
  manifestText = text;
  const m = JSON.parse(text);
  sections = m.sections || [];
  pending = m.pending || [];
  if (m.name) {
    $("board-title").textContent = `${m.name} · review`;
  }
  if (m.title) document.querySelector("aside h1").textContent = m.title;
  stackUrl = m.stackUrl || "";
}

async function poll() {
  try {
    const text = await fetch(`/api/manifest${location.search}`).then((r) => r.text());
    const stamp = $("poll-stamp");
    if (stamp) stamp.textContent = `Last checked ${new Date().toLocaleTimeString()}`;
    if (text === manifestText) return;
    const old = new Map(sections.map((s) => [s.id, JSON.stringify(s)]));
    const current = $("section").hidden ? null : sections[index];
    const draft = $("note").value;
    applyManifest(text);
    const changed = sections.filter((s) => old.has(s.id) && old.get(s.id) !== JSON.stringify(s));
    for (const s of changed) revs[s.id] = Date.now();
    const arrived = sections.filter((s) => !old.has(s.id) && !verdicts[s.id]?.status);
    if (arrived.length) alertArrival(arrived);
    if (!current) {
      if (arrived.length) return go(sections.indexOf(arrived[0]));
      return refreshSummary();
    }
    const busy = !verdicts[current.id]?.status && draft.trim();
    if (arrived.length && !busy) {
      toast(`New round ready: ${arrived[0].title}`);
      return go(sections.indexOf(arrived[0]));
    }
    const at = sections.findIndex((s) => s.id === current.id);
    if (at < 0) return go(Math.min(index, sections.length - 1));
    index = at;
    if (changed.includes(sections[at])) {
      const y = window.scrollY;
      renderSection(true);
      if (busy) $("note").value = draft;
      syncVerdictUi();
      window.scrollTo({ top: y });
    } else {
      renderToc();
    }
    if (arrived.length) toast(`New round ready: ${arrived[0].title}. Open it from Sections.`);
  } catch {}
}

function refreshSummary() {
  const y = window.scrollY;
  renderSummary();
  window.scrollTo({ top: y });
}

function startPoll() {
  if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
}

function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function go(i) {
  editing = null;
  if (i >= sections.length) return renderSummary();
  startPoll();
  index = Math.max(0, i);
  renderSection();
}

async function save(status) {
  const s = sections[index];
  const mainNote = $("note").value.trim();
  const notes = shotNotesFor(s);
  const lines = Object.entries(notes).map(([label, text]) => `[${label}] ${text}`);
  const entry = { status, note: [mainNote, ...lines].filter(Boolean).join("\n"), at: new Date().toISOString() };
  if (lines.length) Object.assign(entry, { mainNote, shotNotes: notes });
  const cur = s.variants?.[variant];
  if (cur && status === "approved") entry.variant = cur.key;
  try {
    const res = await fetch("/api/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [s.id]: entry }),
    });
    if (!res.ok) throw new Error();
    verdicts[s.id] = entry;
    return true;
  } catch {
    toast("Save failed. Is the board server running?");
    return false;
  }
}

const sentMsg = { approved: "Approved.", approvedNote: "Approved. Your note goes back as a follow-up round.", changes: "Sent back for rework.", skip: "Skipped for now.", more: "Sent back for new versions." };

$("note").addEventListener("input", syncVerdictUi);
$("change").addEventListener("click", () => {
  editing = sections[index].id;
  const y = window.scrollY;
  renderSection(true);
  window.scrollTo({ top: y });
  syncVerdictUi();
  if (!$("note-row").hidden) $("note").focus();
});
$("note-btn").addEventListener("click", () => {
  const open = $("note-row").hidden;
  showNote(open);
  if (open) $("note").focus();
});
$("note").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !(e.ctrlKey || e.metaKey || e.shiftKey)) e.preventDefault();
});
$("verdict").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = e.submitter?.value || "approved";
  const note = $("note").value.trim() || Object.values(shotNotesFor(sections[index])).join(" ");
  if (status === "changes" && !note) {
    toast("Add a note first. A rework needs direction.");
    showNote(true);
    return $("note").focus();
  }
  if (!(await save(status))) return;
  editing = null;
  const key = keyOf(status, note);
  $("section").dataset.verdict = key;
  if (key === "approved") confetti();
  const pick = verdicts[sections[index].id].variant;
  toast(pick && status === "approved" ? `Picked ${pick}. ${note ? "Your note goes back as a follow-up round." : ""}`.trim() : sentMsg[key]);
  setTimeout(() => go(index + 1), 450);
});
function applyMode(mode) {
  document.documentElement.dataset.theme = mode;
  const label = mode === "dark" ? "Switch to light (board and screenshots)" : "Switch to dark (board and screenshots)";
  for (const b of [$("mode"), $("shot-mode")]) {
    setIcon(b, mode === "dark" ? "sun" : "moon");
    b.title = label;
    b.setAttribute("aria-label", label);
  }
}
const toggleMode = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyMode(next);
  try {
    localStorage.setItem("verify-mode", next);
  } catch {}
  if (!$("section").hidden && sections[index]) {
    const y = window.scrollY;
    const note = $("note").value;
    renderSection(true);
    if (!verdicts[sections[index].id]?.status) $("note").value = note;
    syncVerdictUi();
    window.scrollTo({ top: y });
  }
};
$("mode").addEventListener("click", toggleMode);
$("shot-mode").addEventListener("click", toggleMode);
try {
  applyMode(localStorage.getItem("verify-mode") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
} catch {
  applyMode("light");
}
$("prev").addEventListener("click", () => go(index - 1));
$("next").addEventListener("click", () => go(index + 1));
$("zoom-close").addEventListener("click", () => $("zoom").close());
const widthIcon = { all: "all", mobile: "phone", tablet: "tablet", desktop: "monitor" };
const widthName = { all: "All widths", mobile: "Mobile", tablet: "Tablet", desktop: "Desktop" };
function syncWidthBtn() {
  setIcon($("width-btn"), widthIcon[width]);
  $("width-btn").title = `Screen width: ${widthName[width]}`;
  $("width-btn").setAttribute("aria-label", `Screen width: ${widthName[width]}`);
}
function openWidthMenu(open) {
  $("width-menu").hidden = !open;
  $("width-btn").setAttribute("aria-expanded", String(open));
  if (open) $("width-menu").querySelector('[aria-checked="true"]').focus();
}
$("width-btn").addEventListener("click", () => openWidthMenu($("width-menu").hidden));
for (const item of document.querySelectorAll("#width-menu [data-w]")) {
  item.addEventListener("click", () => {
    width = item.dataset.w;
    for (const t of document.querySelectorAll("#width-menu [data-w]")) t.setAttribute("aria-checked", String(t === item));
    syncWidthBtn();
    openWidthMenu(false);
    $("width-btn").focus();
    renderSection();
  });
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".pk-menu-wrap")) openWidthMenu(false);
});
$("width-menu").addEventListener("keydown", (e) => {
  const items = [...$("width-menu").querySelectorAll("[data-w]")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    openWidthMenu(false);
    $("width-btn").focus();
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
for (const t of document.querySelectorAll("#width-menu [data-w]")) t.setAttribute("aria-checked", String(t.dataset.w === width));
syncWidthBtn();
document.addEventListener("keydown", (e) => {
  if (e.target.closest("textarea,input,.pk-menu")) return;
  if (hasVariants()) {
    if (e.key === "ArrowRight") return stepVariant(1);
    if (e.key === "ArrowLeft") return stepVariant(-1);
    const n = Number(e.key);
    if (n >= 1 && n <= sections[index].variants.length) {
      variant = n - 1;
      return stepVariant(0);
    }
  }
  if (e.key === "ArrowRight") go(index + 1);
  if (e.key === "ArrowLeft") go(index - 1);
});
$("v-prev").addEventListener("click", () => stepVariant(-1));
$("v-next").addEventListener("click", () => stepVariant(1));
$("sec-title").tabIndex = -1;

(async () => {
  const [text, v] = await Promise.all([fetch(`/api/manifest${location.search}`).then((r) => r.text()), fetch("/api/verdicts").then((r) => r.json())]);
  applyManifest(text);
  verdicts = v || {};
  const [hash, hashVariant] = decodeURIComponent(location.hash.slice(1)).split(":");
  pendingVariant = hashVariant || null;
  const remembered = sections.findIndex((x) => x.id === hash);
  const next = firstUnreviewed();
  if (hash === "overview") renderSummary();
  else if (remembered >= 0) go(remembered);
  else if (next >= 0) go(next);
  else renderSummary();
})();
(() => {
  const handle = $("nav-resize");
  const root = document.documentElement;
  const min = 240;
  const max = () => Math.round(innerWidth * 0.6);
  const clamp = (w) => Math.min(max(), Math.max(min, Math.round(w)));
  const current = () => document.querySelector("aside").getBoundingClientRect().width;
  const sync = () => {
    const w = Math.round(current());
    handle.setAttribute("aria-valuenow", String(w));
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max()));
  };
  const set = (w, save = true) => {
    if (w === null) root.style.removeProperty("--nav-w");
    else root.style.setProperty("--nav-w", `${clamp(w)}px`);
    sync();
    if (!save) return;
    try {
      if (w === null) localStorage.removeItem("verify-nav-w");
      else localStorage.setItem("verify-nav-w", String(clamp(w)));
    } catch {}
  };
  try {
    const saved = Number(localStorage.getItem("verify-nav-w"));
    if (saved) set(saved, false);
  } catch {}
  sync();
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (handle.classList.contains("dragging")) set(e.clientX, false);
  });
  const end = () => {
    if (!handle.classList.contains("dragging")) return;
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing");
    set(current());
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => set(null));
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") set(current() - step);
    else if (e.key === "ArrowRight") set(current() + step);
    else if (e.key === "Home") set(min);
    else if (e.key === "End") set(max());
    else if (e.key === "Enter") set(null);
    else return;
    e.preventDefault();
  });
  addEventListener("resize", sync);
})();

(() => {
  const btn = $("nav-compact");
  const root = document.documentElement;
  const apply = (on, save = true) => {
    root.classList.toggle("nav-compact", on);
    btn.setAttribute("aria-pressed", String(on));
    setIcon(btn, on ? "right" : "left");
    const label = on ? "Expand sections panel to the default size" : "Compact sections panel";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    if (!save) return;
    try {
      localStorage.setItem("verify-nav-compact", on ? "1" : "");
    } catch {}
  };
  try {
    apply(localStorage.getItem("verify-nav-compact") === "1", false);
  } catch {
    apply(false, false);
  }
  btn.addEventListener("click", () => {
    const on = !root.classList.contains("nav-compact");
    if (!on) {
      root.style.removeProperty("--nav-w");
      try {
        localStorage.removeItem("verify-nav-w");
      } catch {}
    }
    apply(on);
  });
})();

let unseen = 0;
const boardName = () => document.querySelector("aside h1")?.textContent.trim() || "Review board";
function drawFavicon(count) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue("--acc").trim() || "#0f766e";
  g.beginPath();
  g.roundRect(4, 4, 56, 56, 14);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 36px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("V", 32, 35);
  if (count > 0) {
    g.fillStyle = "#dc2626";
    g.beginPath();
    g.arc(46, 18, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 20px system-ui, sans-serif";
    g.fillText(count > 9 ? "9+" : String(count), 46, 19);
  }
  $("favicon").href = c.toDataURL("image/png");
}
function updateTab() {
  const waiting = sections.filter(needsAttention).length;
  const s = !$("section").hidden && sections[index];
  const where = s ? `${s.title}${s.round ? ` r${s.round}` : ""}` : "Overview";
  const lead = unseen ? "● New round · " : "";
  const count = waiting ? `(${waiting}) ` : "";
  document.title = `${count}${lead}${where} · ${boardName()}`;
  drawFavicon(waiting);
}
function alertArrival(arrived) {
  if (document.hidden) unseen += arrived.length;
  updateTab();
  if (!document.hidden || !alertsOn()) return;
  const n = new Notification(`${boardName()}: ${arrived.length === 1 ? "a round is" : `${arrived.length} rounds are`} ready`, {
    body: arrived.map((s) => s.title).join(", "),
    tag: `verify-${location.search}`,
  });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && unseen) {
    unseen = 0;
    updateTab();
  }
});
const alertsOn = () => typeof Notification !== "undefined" && Notification.permission === "granted";
let alertsAsked = false;
async function attentionClick() {
  if (!alertsAsked && typeof Notification !== "undefined" && Notification.permission === "default") {
    alertsAsked = true;
    const p = await Notification.requestPermission();
    toast(p === "granted" ? "Desktop alerts are on while this tab is in the background." : "No desktop alerts. The tab title and icon still show what is waiting.");
    renderToc();
  }
  if (sections.some(needsAttention)) goNextAttention();
  else toast("All caught up.");
}

let highlight = (() => {
  try {
    return localStorage.getItem("verify-highlight") !== "off";
  } catch {
    return true;
  }
})();
const DIFF_CACHE = new Map();
const DIFF_CELL = 12;
const DIFF_MAX = 12;

const loadImage = (src) =>
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0 ? image : null);
    image.onerror = () => resolve(null);
    image.src = src;
  });

function pixelsOf(image, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

function diffRegions(cells, cols, rows, bounds) {
  const seen = new Uint8Array(cols * rows);
  const found = [];
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || cells[start] < 2) continue;
    const stack = [start];
    seen[start] = 1;
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    let px = 0;
    while (stack.length) {
      const c = stack.pop();
      px += cells[c];
      x0 = Math.min(x0, bounds[c * 4]);
      y0 = Math.min(y0, bounds[c * 4 + 1]);
      x1 = Math.max(x1, bounds[c * 4 + 2]);
      y1 = Math.max(y1, bounds[c * 4 + 3]);
      const cx = c % cols;
      const cy = (c / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (seen[n] || cells[n] < 2) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (px >= 24) found.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, px });
  }
  const kept = found.sort((a, b) => b.px - a.px).slice(0, DIFF_MAX);
  kept.sort((a, b) => a.y - b.y || a.x - b.x);
  kept.forEach((r, i) => (r.n = i + 1));
  return kept;
}

async function computeDiff(beforeSrc, afterSrc) {
  const [a, b] = await Promise.all([loadImage(beforeSrc), loadImage(afterSrc)]);
  if (!a || !b) return null;
  const w = Math.max(a.naturalWidth, b.naturalWidth);
  const h = Math.max(a.naturalHeight, b.naturalHeight);
  const pa = pixelsOf(a, w, h);
  const pb = pixelsOf(b, w, h);
  const cols = Math.ceil(w / DIFF_CELL);
  const rows = Math.ceil(h / DIFF_CELL);
  const cells = new Uint16Array(cols * rows);
  const bounds = new Int32Array(cols * rows * 4);
  for (let c = 0; c < cols * rows; c++) {
    bounds[c * 4] = 1e9;
    bounds[c * 4 + 1] = 1e9;
    bounds[c * 4 + 2] = -1;
    bounds[c * 4 + 3] = -1;
  }
  let changed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const d = Math.abs(pa[j] - pb[j]) + Math.abs(pa[j + 1] - pb[j + 1]) + Math.abs(pa[j + 2] - pb[j + 2]) + Math.abs(pa[j + 3] - pb[j + 3]);
      if (d <= 48) continue;
      changed++;
      const c = ((y / DIFF_CELL) | 0) * cols + ((x / DIFF_CELL) | 0);
      cells[c]++;
      const k = c * 4;
      if (x < bounds[k]) bounds[k] = x;
      if (y < bounds[k + 1]) bounds[k + 1] = y;
      if (x > bounds[k + 2]) bounds[k + 2] = x;
      if (y > bounds[k + 3]) bounds[k + 3] = y;
    }
  }
  return { w, h, regions: diffRegions(cells, cols, rows, bounds), pct: (changed / (w * h)) * 100 };
}

const diffOf = (beforeSrc, afterSrc) => {
  const key = `${beforeSrc}|${afterSrc}`;
  if (!DIFF_CACHE.has(key)) DIFF_CACHE.set(key, computeDiff(beforeSrc, afterSrc).catch(() => null));
  return DIFF_CACHE.get(key);
};

function overlay(fig, d) {
  const img = fig.querySelector("img");
  if (!img) return;
  const wrap = el("div", "hl-wrap");
  img.replaceWith(wrap);
  wrap.append(img);
  for (const r of d.regions) {
    const box = el("span", "hl-box");
    box.style.left = `${(r.x / d.w) * 100}%`;
    box.style.top = `${(r.y / d.h) * 100}%`;
    box.style.width = `${(r.w / d.w) * 100}%`;
    box.style.height = `${(r.h / d.h) * 100}%`;
    box.append(el("span", "hl-badge", String(r.n)));
    wrap.append(box);
  }
}

async function markChanges(head, fb, fa, beforeSrc, afterSrc) {
  const d = await diffOf(beforeSrc, afterSrc);
  if (!fa.isConnected) return;
  const n = d ? d.regions.length : 0;
  const stat = el("span", "hl-stat", d ? (n ? `${n} changed area${n === 1 ? "" : "s"}` : "No visible change") : "");
  if (d) head.insertBefore(stat, head.children[1] || null);
  if (!d || !n) return;
  overlay(fb, d);
  overlay(fa, d);
}

function syncHlBtn() {
  const b = $("hl-btn");
  const label = highlight ? "Hide change highlights" : "Highlight what changed";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", String(highlight));
  b.classList.toggle("on", highlight);
}
$("hl-btn").addEventListener("click", () => {
  highlight = !highlight;
  try {
    localStorage.setItem("verify-highlight", highlight ? "on" : "off");
  } catch {}
  syncHlBtn();
  const y = window.scrollY;
  renderSection(true);
  window.scrollTo({ top: y });
});
syncHlBtn();

const pairViews = {};
function viewSwitch(pair, key, beforeCap, afterCap) {
  const group = el("div", "view-switch");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Show");
  const opts = [["both", "Side by side"], ["before", beforeCap], ["after", afterCap]];
  const apply = (v) => {
    pairViews[key] = v;
    pair.classList.toggle("only-before", v === "before");
    pair.classList.toggle("only-after", v === "after");
    for (const b of group.children) b.setAttribute("aria-pressed", String(b.dataset.v === v));
  };
  for (const [v, text] of opts) {
    const b = el("button", "", text);
    b.type = "button";
    b.dataset.v = v;
    b.addEventListener("click", () => apply(v));
    group.append(b);
  }
  group.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const list = [...group.children];
    const i = list.indexOf(document.activeElement);
    const next = list[(i + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
    next.focus();
    apply(next.dataset.v);
  });
  apply(pairViews[key] || "both");
  return group;
}
