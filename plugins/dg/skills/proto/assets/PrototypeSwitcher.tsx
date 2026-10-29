import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  variants: string[];
  current: string;
  prototypeName: string;
  /** Human descriptions for each variant key — shown in the bar and notes panel. */
  labels?: Record<string, string>;
  /** Dev server port. Defaults to window.location.port at runtime. */
  port?: number;
  /** App basePath (e.g. Next `basePath` config), prefixed to the confirm fetch URL. */
  basePath?: string;
  /** Quick-pick reasons shown as chips in the note row. */
  rejectReasons?: string[];
}

const DEFAULT_REJECT_REASONS = [
  "Doesn't fit the use case",
  "Too cluttered / busy",
  "Wrong layout or hierarchy",
  "None of these — go more radical",
  "Close, but needs tweaks",
];

type Width = "all" | "mobile" | "tablet" | "desktop";
const WIDTHS: { key: Width; icon: string; label: string }[] = [
  { key: "all", icon: "all", label: "All widths" },
  { key: "mobile", icon: "phone", label: "Mobile" },
  { key: "tablet", icon: "tablet", label: "Tablet" },
  { key: "desktop", icon: "monitor", label: "Desktop" },
];
const WIDTH_NAMES: Record<Width, string> = { all: "all", mobile: "mobile 390", tablet: "tablet 768", desktop: "desktop 1440" };
const TEXT_ICONS: Record<string, string> = {
  sun: "☀", moon: "☾", all: "▦", phone: "▯", tablet: "▭", monitor: "▬", left: "‹", right: "›", note: "✎", check: "✓", rework: "⟳",
};
const CONFETTI_COLORS = ["#22c55e", "#4c8dff", "#a855f7", "#f59e0b", "#f43f5e", "#14b8a6"];

declare global {
  interface Window {
    dgIcons?: { svg(name: string): string };
  }
}

function Icon({ name }: { name: string }) {
  const svg = typeof window !== "undefined" ? window.dgIcons?.svg(name) : undefined;
  if (svg) return <span className="ps-glyph" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
  return <span className="ps-glyph" aria-hidden="true">{TEXT_ICONS[name] ?? ""}</span>;
}

const SWITCHER_STYLE_ID = "ps-switcher-styles";
const SWITCHER_CSS = `
.ps-bar{--ps-surface:#ffffff;--ps-surface-2:#fafaf8;--ps-fg:#18181b;--ps-mut:#5f5f66;--ps-line:#cfcfc8;--ps-acc:#0f766e;--ps-acc-soft:#e6f4f2;
  --ps-ok:#15803d;--ps-ok-soft:#e8f6ec;--ps-bad:#dc2626;--ps-bad-soft:#fdecec;--ps-note:#a16207;--ps-note-soft:#fef6c7;
  position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9999;max-width:calc(100vw - 32px);padding:6px;box-sizing:border-box;
  background:var(--ps-surface);color:var(--ps-fg);border:1px solid var(--ps-line);border-radius:10px;box-shadow:0 8px 24px rgb(15 23 42/.18);
  font:13px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none}
html.dark .ps-bar,html.dark .ps-toast{--ps-surface:#1b1b1e;--ps-surface-2:#202024;--ps-fg:#f4f4f5;--ps-mut:#a1a1aa;--ps-line:#3f3f46;--ps-acc:#2dd4bf;--ps-acc-soft:#123430;
  --ps-ok:#4ade80;--ps-ok-soft:#14301f;--ps-bad:#f87171;--ps-bad-soft:#3a1616;--ps-note:#facc15;--ps-note-soft:#36310f}
.ps-bar[data-verdict="changes"]{border-color:var(--ps-bad)}
.ps-bar.is-working{border-color:transparent;background:linear-gradient(var(--ps-surface),var(--ps-surface)) padding-box,
  conic-gradient(from var(--ps-spin),var(--ps-acc),transparent 35%,transparent 65%,var(--ps-acc)) border-box;animation:ps-ring 1.6s linear infinite}
@property --ps-spin{syntax:"<angle>";inherits:false;initial-value:0deg}
@keyframes ps-ring{to{--ps-spin:360deg}}
.ps-row{display:flex;align-items:center;gap:4px;justify-content:center;flex-wrap:wrap}
.ps-ic{width:38px;height:38px;padding:0;display:inline-grid;place-items:center;position:relative;border:1px solid transparent;border-radius:8px;
  background:transparent;color:var(--ps-mut);font:inherit;cursor:pointer}
.ps-ic:hover{background:var(--ps-surface-2);color:var(--ps-fg)}
.ps-ic:disabled{opacity:.35;cursor:default}
.ps-glyph{display:inline-grid;place-items:center}
.ps-approve{color:var(--ps-ok);border-color:var(--ps-ok);background:var(--ps-ok-soft)}
.ps-approve.with-note{color:var(--ps-note);border-color:var(--ps-note);background:var(--ps-note-soft)}
.ps-reject{color:var(--ps-bad);border-color:var(--ps-bad);background:var(--ps-bad-soft)}
.ps-note[aria-pressed="true"]{background:var(--ps-acc-soft);color:var(--ps-acc);border-color:var(--ps-acc)}
.ps-note.has-note::after{content:"";position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:var(--ps-note);box-shadow:0 0 0 2px var(--ps-surface)}
.ps-sep{width:1px;height:22px;background:var(--ps-line);margin:0 4px}
.ps-group{display:contents}
.ps-label{padding:0 6px;white-space:nowrap;font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis}
.ps-label small{font-weight:400;color:var(--ps-mut);margin-left:4px}
.ps-menu-wrap{position:relative}
.ps-bar [hidden],.ps-toast[hidden],.ps-overlay [hidden]{display:none!important}
.ps-menu{position:absolute;bottom:calc(100% + 8px);left:0;min-width:170px;padding:4px;display:grid;gap:2px;background:var(--ps-surface);
  border:1px solid var(--ps-line);border-radius:10px;box-shadow:0 10px 30px rgb(0 0 0/.18)}
.ps-menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:6px 10px;border:0;border-radius:7px;background:none;
  color:var(--ps-fg);font:inherit;text-align:left;cursor:pointer}
.ps-menu button:hover,.ps-menu button:focus-visible{background:var(--ps-surface-2)}
.ps-menu button[aria-checked="true"]{background:var(--ps-acc-soft);color:var(--ps-acc)}
.ps-note-row{padding:4px 4px 8px}
.ps-note-row textarea{width:100%;min-width:min(480px,80vw);min-height:4.5rem;box-sizing:border-box;resize:vertical;font:inherit;color:inherit;
  background:var(--ps-surface-2);border:1px solid var(--ps-line);border-radius:8px;padding:9px 11px}
.ps-bar:has(.with-note) .ps-note-row textarea{border-color:var(--ps-note);background:var(--ps-note-soft)}
.ps-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.ps-chips button{font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--ps-line);background:var(--ps-surface-2);color:var(--ps-fg);cursor:pointer}
.ps-error{color:var(--ps-bad);font-size:12px;padding:4px 6px 0;text-align:center}
.ps-toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:9999;max-width:min(60ch,calc(100vw - 32px));padding:10px 14px;
  background:var(--ps-surface,#fff);color:var(--ps-fg,#18181b);border:1px solid var(--ps-line,#cfcfc8);border-radius:10px;box-shadow:0 8px 24px rgb(15 23 42/.18);
  font:13px ui-sans-serif,system-ui,sans-serif}
html[data-proto-width="mobile"] body{max-width:390px;margin-inline:auto}
html[data-proto-width="tablet"] body{max-width:768px;margin-inline:auto}
html[data-proto-width="desktop"] body{max-width:1440px;margin-inline:auto}
@keyframes burst { 0%{transform:translate(0,0) rotate(0);opacity:1} 100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot));opacity:0} }
@keyframes glow { 0%,100%{box-shadow:0 0 0 8px rgba(34,197,94,.16),0 10px 40px rgba(34,197,94,.35)} 50%{box-shadow:0 0 0 14px rgba(34,197,94,.06),0 10px 60px rgba(34,197,94,.6)} }
@keyframes pop { 0%{transform:scale(.3);opacity:0} 100%{transform:scale(1);opacity:1} }
@keyframes draw { to { stroke-dashoffset:0 } }
.ps-confetti-particle {
  position: fixed; top: 38vh; left: 50%; width: 10px; height: 14px;
  border-radius: 2px; pointer-events: none; z-index: 10001;
  animation: burst .9s ease-out forwards;
}
.ps-check-badge { animation: pop .4s ease, glow 2s ease-in-out .4s infinite; }
.ps-check-badge.is-working { animation: pop .4s ease; border: 3px solid transparent;
  background: linear-gradient(#16a34a,#22c55e) padding-box, conic-gradient(from var(--ps-spin),#2dd4bf,transparent 35%,transparent 65%,#2dd4bf) border-box;
  animation: pop .4s ease, ps-ring 1.6s linear infinite; }
.ps-check-path { stroke-dasharray: 48; stroke-dashoffset: 48; animation: draw .5s .25s ease forwards; }
@media (max-width:760px){.ps-bar{width:calc(100vw - 32px)}.ps-note-row textarea{min-width:0}
  .ps-row{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"nav nav nav" "tools . act";row-gap:4px}
  .ps-row>.ps-sep{display:none}.ps-group{display:flex;align-items:center;gap:4px}
  .ps-nav{grid-area:nav;justify-content:space-between;border-bottom:1px solid var(--ps-line);padding-bottom:4px}.ps-nav .ps-label{max-width:none;text-align:center}
  .ps-tools{grid-area:tools}.ps-act{grid-area:act}}
@media (prefers-reduced-motion:reduce){.ps-bar,.ps-bar *,.ps-check-badge,.ps-check-path,.ps-confetti-particle{animation:none!important;transition:none!important}.ps-check-path{stroke-dashoffset:0}}
`;

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 10000,
  background: "radial-gradient(120% 120% at 50% 0%, #10371f 0%, rgba(8,12,16,.98) 60%)",
  color: "#fff",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  fontFamily: "system-ui, sans-serif",
};

const checkBadge: React.CSSProperties = {
  width: 96,
  height: 96,
  borderRadius: "50%",
  background: "linear-gradient(135deg,#16a34a,#22c55e)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const noteQuote: React.CSSProperties = {
  fontSize: 14,
  opacity: 0.85,
  maxWidth: 420,
  fontStyle: "italic",
  borderLeft: "3px solid #22c55e",
  paddingLeft: 12,
  textAlign: "left",
};

const overlayBtn: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 14,
};

const readMode = (): "light" | "dark" =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "dark"
    ? "dark"
    : "light";

const readWidth = (): Width => {
  const w = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("width") : null;
  return WIDTHS.some(entry => entry.key === w) ? (w as Width) : "all";
};

const FAVICON_EMOJI = { waiting: "⏳", processing: "🔄", done: "✅" } as const;
const faviconHref = (state: keyof typeof FAVICON_EMOJI): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="54" font-size="80" text-anchor="middle" dominant-baseline="central">${FAVICON_EMOJI[state]}</text></svg>`,
  )}`;

export default function PrototypeSwitcher({
  variants,
  current,
  prototypeName,
  labels,
  port,
  basePath = "",
  rejectReasons = DEFAULT_REJECT_REASONS,
}: Props) {
  const [outcome, setOutcome] = useState<"confirm" | "reject" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [width, setWidth] = useState<Width>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confetti, setConfetti] = useState<
    { id: number; dx: number; dy: number; rot: number; color: string; delay: number }[]
  >([]);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const widthBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const addReason = useCallback((r: string) => {
    setNotes(prev => {
      const lines = prev.split("\n").map(s => s.trim());
      if (lines.includes(r)) return prev;
      return prev ? `${prev}\n${r}` : r;
    });
  }, []);

  const idx = variants.indexOf(current);
  const prev = variants[(idx - 1 + variants.length) % variants.length];
  const next = variants[(idx + 1) % variants.length];

  const setParam = useCallback((key: string, value: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(key, value);
    history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const go = useCallback((key: string) => setParam("variant", key), [setParam]);

  const say = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const sync = () => {
      const m = readMode();
      const w = readWidth();
      setMode(m);
      setWidth(w);
      document.documentElement.classList.toggle("dark", m === "dark");
      if (w === "all") document.documentElement.removeAttribute("data-proto-width");
      else document.documentElement.setAttribute("data-proto-width", w);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const toggleMode = useCallback(() => setParam("mode", readMode() === "dark" ? "light" : "dark"), [setParam]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const state = outcome === "reject" ? "processing" : outcome === "confirm" ? "done" : "waiting";
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = faviconHref(state);
  }, [outcome]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (document.getElementById(SWITCHER_STYLE_ID)) return;
    const styleEl = document.createElement("style");
    styleEl.id = SWITCHER_STYLE_ID;
    styleEl.textContent = SWITCHER_CSS;
    document.head.appendChild(styleEl);
  }, []);

  useEffect(() => {
    if (outcome !== "confirm" || notes.trim()) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const particles = Array.from({ length: 28 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 28 + (i % 3) * 0.12;
      const dist = 160 + (i % 5) * 44;
      return {
        id: i,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist - 40,
        rot: i * 47,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        delay: (i % 6) * 0.03,
      };
    });
    setConfetti(particles);
    const timer = window.setTimeout(() => setConfetti([]), 1200);
    return () => clearTimeout(timer);
  }, [outcome, notes]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const editable = (e.target as HTMLElement).isContentEditable;
      if (tag === "INPUT" || tag === "TEXTAREA" || editable || menuOpen) return;
      if (e.key === "ArrowLeft") go(prev);
      if (e.key === "ArrowRight") go(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, prev, next, menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".ps-menu-wrap")) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  const onMenuKey = useCallback((e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
    if (e.key === "Escape") {
      setMenuOpen(false);
      widthBtnRef.current?.focus();
    }
  }, []);

  const showNotes = useCallback((open: boolean) => {
    setNotesOpen(open);
    if (open) window.setTimeout(() => noteRef.current?.focus(), 0);
  }, []);

  const closeTab = useCallback(() => {
    try {
      window.open("", "_self");
    } catch {}
    window.close();
  }, []);

  const submit = useCallback(
    (action: "confirm" | "reject") => {
      setError(null);
      if (action === "reject" && !notes.trim()) {
        showNotes(true);
        say("Add a note first. A rework needs direction.");
        return;
      }
      const basePort = port ?? (window.location.port || undefined);
      const base = basePort
        ? `${window.location.protocol}//${window.location.hostname}:${basePort}`
        : window.location.origin;
      const url = `${base}${basePath}/prototype-confirm`;
      const payload = JSON.stringify({ name: prototypeName, variant: current, variants, notes, action });

      const closeAfter = action === "confirm" && notes.trim().length === 0;

      setSubmitting(true);
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      })
        .then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
            return;
          }
          setOutcome(action);
          if (action === "reject") say("Sent back for rework.");
          if (closeAfter) window.setTimeout(closeTab, 2200);
        })
        .catch(err => {
          setError(err instanceof Error ? err.message : "Network error");
        })
        .finally(() => setSubmitting(false));
    },
    [port, basePath, prototypeName, current, variants, notes, closeTab, showNotes, say],
  );

  if (process.env.NODE_ENV === "production") return null;

  if (outcome === "confirm") {
    const isBuilding = notes.trim().length > 0;
    return (
      <div style={overlay} onFocus={e => e.stopPropagation()}>
        {confetti.map(p => (
          <div
            key={p.id}
            className="ps-confetti-particle"
            style={
              {
                background: p.color,
                animationDelay: `${p.delay}s`,
                "--dx": `${p.dx}px`,
                "--dy": `${p.dy}px`,
                "--rot": `${p.rot}deg`,
              } as React.CSSProperties
            }
          />
        ))}
        <div className={`ps-check-badge${isBuilding ? " is-working" : ""}`} style={checkBadge}>
          <svg viewBox="0 0 52 52" width={52} height={52} aria-hidden="true">
            <path
              className="ps-check-path"
              fill="none"
              stroke="#fff"
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M14 27 l8 8 l16 -18"
            />
          </svg>
        </div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>
          {isBuilding ? `Building the next round from ${current}…` : `Selected variant ${current}`}
        </div>
        {notes.trim() && <div style={noteQuote}>"{notes.trim()}"</div>}
        <div style={{ fontSize: 16, opacity: 0.7 }}>
          {isBuilding
            ? "Keep this tab open — it reloads in place when the next round is ready."
            : "Selection recorded — this tab will close automatically."}
        </div>
        <button type="button" style={overlayBtn} onClick={() => setOutcome(null)}>
          Keep exploring
        </button>
      </div>
    );
  }

  const label = labels?.[current];
  const hasNotes = notes.trim().length > 0;
  const working = submitting || outcome === "reject";
  const widthName = `Width: ${WIDTH_NAMES[width]}`;
  const approveLabel = hasNotes ? "Approve + note" : "Approve";

  return (
    <div onFocus={e => e.stopPropagation()}>
      {toast && (
        <div className="ps-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      <div
        className={`ps-bar${working ? " is-working" : ""}`}
        data-verdict={outcome === "reject" ? "changes" : undefined}
        role="toolbar"
        aria-label="Prototype decision"
      >
        {notesOpen && (
          <div className="ps-note-row" id="ps-note-row">
            <textarea
              ref={noteRef}
              id="proto-notes"
              aria-label={`Note for variant ${current}`}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Note: optional for Approve, required for Reject. What should change?"
              rows={3}
            />
            <div className="ps-chips">
              {rejectReasons.map(r => (
                <button type="button" key={r} onClick={() => addReason(r)}>
                  + {r}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="ps-row">
          <div className="ps-group ps-tools">
          <button
            type="button"
            className="ps-ic"
            onClick={toggleMode}
            title={mode === "dark" ? "Light mode" : "Dark mode"}
            aria-label={mode === "dark" ? "Light mode" : "Dark mode"}
          >
            <Icon name={mode === "dark" ? "sun" : "moon"} />
          </button>
          <div className="ps-menu-wrap">
            <button
              ref={widthBtnRef}
              type="button"
              className="ps-ic"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls="ps-width-menu"
              title={widthName}
              aria-label={widthName}
              onClick={() => setMenuOpen(open => !open)}
            >
              <Icon name={WIDTHS.find(entry => entry.key === width)?.icon ?? "all"} />
            </button>
            {menuOpen && (
              <div ref={menuRef} id="ps-width-menu" className="ps-menu" role="menu" aria-label="Preview width" onKeyDown={onMenuKey}>
                {WIDTHS.map(entry => (
                  <button
                    type="button"
                    key={entry.key}
                    role="menuitemradio"
                    aria-checked={entry.key === width}
                    onClick={() => {
                      setParam("width", entry.key);
                      setMenuOpen(false);
                      widthBtnRef.current?.focus();
                    }}
                  >
                    <Icon name={entry.icon} />
                    {entry.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          </div>
          <span className="ps-sep" aria-hidden="true" />
          <div className="ps-group ps-nav">
          <button type="button" className="ps-ic" onClick={() => go(prev)} title="Previous variant (←)" aria-label="Previous variant">
            <Icon name="left" />
          </button>
          <span className="ps-label">
            {current}
            {label && <small>{label}</small>}
          </span>
          <button type="button" className="ps-ic" onClick={() => go(next)} title="Next variant (→)" aria-label="Next variant">
            <Icon name="right" />
          </button>
          </div>
          <span className="ps-sep" aria-hidden="true" />
          <div className="ps-group ps-act">
          <button
            type="button"
            className={`ps-ic ps-note${hasNotes ? " has-note" : ""}`}
            aria-pressed={notesOpen}
            aria-controls="ps-note-row"
            onClick={() => showNotes(!notesOpen)}
            title="Note"
            aria-label="Note"
          >
            <Icon name="note" />
          </button>
          <button
            type="button"
            className={`ps-ic ps-approve${hasNotes ? " with-note" : ""}`}
            onClick={() => submit("confirm")}
            disabled={submitting}
            title={approveLabel}
            aria-label={approveLabel}
          >
            <Icon name="check" />
          </button>
          <button
            type="button"
            className="ps-ic ps-reject"
            onClick={() => submit("reject")}
            disabled={submitting}
            title="Reject (note required)"
            aria-label="Reject"
          >
            <Icon name="rework" />
          </button>
          </div>
        </div>
        {error && <div className="ps-error">{error}</div>}
      </div>
    </div>
  );
}
