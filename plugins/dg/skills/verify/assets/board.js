const $ = (id) => document.getElementById(id);
const marks = { approved: "✓", changes: "✎", skip: "–" };
const verdictCls = (v) => (v?.status === "approved" && v.note ? "note" : v?.status || "");
const widthOf = (label) => (label.match(/mobile|tablet|desktop/) || ["other"])[0];
let sections = [];
let pending = [];
let manifestText = "";
let pollTimer = null;
const POLL_MS = 5000;
let verdicts = {};
let index = 0;
let width = "all";

const imgSrc = (path) => (path && path !== "missing" ? path : null);

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
    img.addEventListener("click", () => openZoom(src, img.alt));
    fig.append(img);
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
  if (v.status === "approved") return v.note ? "approved + note" : "approved";
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

function renderToc() {
  const toc = $("toc");
  toc.replaceChildren();
  const overview = el("li", "overview");
  overview.append(tocButton("", "≡", "Overview", "Overview of every item and round", renderSummary, !$("summary").hidden));
  toc.append(overview);
  const showing = $("section").hidden ? null : sections[index];
  for (const chain of chains()) {
    const { rounds, last, waiting } = chain;
    const head = waiting ? null : last;
    const li = el("li");
    const v = head ? verdicts[head.id] : null;
    const headDot = waiting ? "working" : verdictCls(v);
    const headMark = waiting ? "" : (marks[v?.status] || "○");
    const target = rounds.find((r) => !verdicts[r.id]?.status) || last;
    li.append(tocButton(headDot, headMark, last.title, `${last.title}: ${waiting ? "agent working" : statusText(v)}`, () => go(sections.indexOf(target)), rounds.includes(showing) && rounds.length === 1));
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
        sub.append(tocButton(verdictCls(rv), String(roundOf(r, i)), r.summary || shortWhat(r), `${r.title}, round ${roundOf(r, i)}: ${statusText(rv)}`, () => go(sections.indexOf(r)), r === showing));
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
}

function renderSection() {
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
  const shots = $("shots");
  shots.replaceChildren();
  for (const im of s.images || []) {
    const w = widthOf(im.label || "");
    if (width !== "all" && w !== width) continue;
    const card = document.createElement("div");
    card.className = "shot";
    const h = document.createElement("h3");
    h.textContent = im.label;
    const pair = document.createElement("div");
    pair.className = `pair w-${w}${im.target ? " has-target" : ""}`;
    pair.append(figure("Before", im.before, im.reason), figure("After", im.after, im.reason));
    if (im.target) pair.append(figure("Prototype", im.target));
    card.append(h, pair);
    shots.append(card);
  }
  if (!shots.children.length) shots.textContent = "No screenshots for this width.";
  const v = verdicts[s.id] || {};
  $("note").value = v.note || "";
  $("section").dataset.verdict = keyOf(v.status, v.note);
  $("note").dataset.saved = v.note || "";
  setLocked(Boolean(v.status), v);
  syncVerdictUi();
  $("prev").disabled = index === 0;
  history.replaceState(null, "", `${location.search}#${encodeURIComponent(s.id)}`);
  renderToc();
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
  if (v.status === "skip" || !v.status) return false;
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

const decidedText = { approved: "Approved", approvedNote: "Approved + note", changes: "Sent back", skip: "Skipped" };

function setLocked(locked, v = {}) {
  const key = keyOf(v.status, v.note);
  $("note").readOnly = locked;
  $("note").value = locked ? "" : $("note").dataset.saved || "";
  for (const b of document.querySelectorAll(".pk-approve,.pk-reject,.pk-skip,.pk-note")) b.hidden = locked;
  showNote(!locked && Boolean($("note").value));
  $("decided-pill").hidden = !locked;
  $("change").hidden = !locked;
  $("decided-pill").textContent = decidedText[key] || "";
  $("decided-pill").className = `pill decided-pill ${key}`;
  const pop = locked && v.note;
  $("note-pop").hidden = !pop;
  if (pop) {
    $("note-pop").className = `note-pop ${key}`;
    $("note-pop-verdict").textContent = decidedText[key];
    $("note-pop-verdict").className = `pill ${key}`;
    $("note-pop-at").textContent = v.at ? new Date(v.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    $("note-pop-text").textContent = v.note;
  }
}

function showNote(open) {
  $("note-row").hidden = !open;
  $("note-btn").setAttribute("aria-pressed", String(open));
}

function syncVerdictUi() {
  const note = Boolean($("note").value.trim());
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
  const followUps = open.filter((s) => verdicts[s.id]?.status === "approved" && verdicts[s.id]?.note);
  const skipped = sections.filter((s) => verdicts[s.id]?.status === "skip");
  const allGood = sections.length > 0 && !pending.length && sections.every(resolved);
  if (allGood) {
    stopPoll();
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
  startPoll();
}

function chainState(chain) {
  if (chain.waiting) return "In progress";
  const v = verdicts[chain.last.id];
  if (!v?.status) return "Needs review";
  if (v.status === "skip") return "Skipped";
  if (v.status === "changes" || v.note) return "Waiting on agent";
  return "Done";
}

function renderSummary() {
  history.replaceState(null, "", `${location.search}#overview`);
  $("section").hidden = true;
  $("summary").hidden = false;
  const body = $("sum-body");
  body.replaceChildren();
  const row = (cells) => {
    const tr = el("tr");
    for (const cell of cells) {
      const td = el("td");
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

function applyManifest(text) {
  manifestText = text;
  const m = JSON.parse(text);
  sections = m.sections || [];
  pending = m.pending || [];
  if (m.name) {
    $("board-title").textContent = `${m.name} · review`;
    document.title = `Verify ${m.name}`;
  }
}

async function poll() {
  try {
    const text = await fetch(`/api/manifest${location.search}`).then((r) => r.text());
    const stamp = $("poll-stamp");
    if (stamp) stamp.textContent = `Last checked ${new Date().toLocaleTimeString()}`;
    if (text === manifestText) return;
    applyManifest(text);
    const next = firstUnreviewed();
    if (next >= 0) {
      stopPoll();
      go(next);
    } else {
      renderSummary();
    }
  } catch {}
}

function startPoll() {
  if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
}

function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function go(i) {
  if (i >= sections.length) return renderSummary();
  stopPoll();
  index = Math.max(0, i);
  renderSection();
}

async function save(status) {
  const s = sections[index];
  const entry = { status, note: $("note").value.trim(), at: new Date().toISOString() };
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

const sentMsg = { approved: "Approved.", approvedNote: "Approved. Your note goes back as a follow-up round.", changes: "Sent back for rework.", skip: "Skipped for now." };

$("note").addEventListener("input", syncVerdictUi);
$("change").addEventListener("click", () => {
  setLocked(false);
  syncVerdictUi();
  if (!$("note-row").hidden) $("note").focus();
});
$("note-btn").addEventListener("click", () => {
  const open = $("note-row").hidden;
  showNote(open);
  if (open) $("note").focus();
});
$("note").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !(e.ctrlKey || e.metaKey)) e.preventDefault();
});
$("verdict").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = e.submitter?.value || "approved";
  const note = $("note").value.trim();
  if (status === "changes" && !note) {
    toast("Add a note first. A rework needs direction.");
    showNote(true);
    return $("note").focus();
  }
  if (!(await save(status))) return;
  const key = keyOf(status, note);
  $("section").dataset.verdict = key;
  if (key === "approved") confetti();
  toast(sentMsg[key]);
  setTimeout(() => go(index + 1), 450);
});
function applyMode(mode) {
  document.documentElement.dataset.theme = mode;
  setIcon($("mode"), mode === "dark" ? "sun" : "moon");
  const label = mode === "dark" ? "Switch to light" : "Switch to dark";
  $("mode").title = label;
  $("mode").setAttribute("aria-label", label);
}
$("mode").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyMode(next);
  try {
    localStorage.setItem("verify-mode", next);
  } catch {}
});
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
syncWidthBtn();
document.addEventListener("keydown", (e) => {
  if (e.target.closest("textarea,input,.pk-menu")) return;
  if (e.key === "ArrowRight") go(index + 1);
  if (e.key === "ArrowLeft") go(index - 1);
});
$("sec-title").tabIndex = -1;

(async () => {
  const [text, v] = await Promise.all([fetch(`/api/manifest${location.search}`).then((r) => r.text()), fetch("/api/verdicts").then((r) => r.json())]);
  applyManifest(text);
  verdicts = v || {};
  const hash = decodeURIComponent(location.hash.slice(1));
  const remembered = sections.findIndex((x) => x.id === hash);
  const next = firstUnreviewed();
  if (hash === "overview") renderSummary();
  else if (remembered >= 0) go(remembered);
  else if (next >= 0) go(next);
  else renderSummary();
})();
