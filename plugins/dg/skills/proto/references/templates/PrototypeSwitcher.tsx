/**
 * PrototypeSwitcher.tsx — Copy into any React/Next.js/Vite prototype.
 *
 * Usage:
 *   import PrototypeSwitcher from './PrototypeSwitcher'
 *   <PrototypeSwitcher variants={['A', 'B', 'C']} current={variant} prototypeName="my-feature" />
 *
 * Wire up: render this at the root of your prototype page. Arrow clicks write
 * ?variant=<key> to the URL via replaceState and dispatch a `popstate` event —
 * host pages that listen for `popstate` will re-render without a full navigation.
 * If your app uses a path prefix (e.g. Next `basePath`), pass it as `basePath`.
 *
 * The bar shows the prototype slug next to the variant key (`slug · A — Description`).
 * Pass `labels` (variant key → human description) to surface the description in both
 * the bar and the notes panel. The light/dark toggle writes `?mode=light|dark`
 * (+ toggles a `dark` class on <html>) so host pages can react to either signal.
 *
 * The bar carries three always-visible decision buttons: 📝 Notes (toggles a
 * free-text panel), Approve ✓ (POSTs action:"confirm"), and Reject ⟲. Reject opens
 * a popup that REQUIRES a note (so a rework always has direction) with quick-pick
 * reason chips — pass `rejectReasons` to tailor them. Whatever note is set rides
 * along with whichever action is sent. Both responses + notes are surfaced by
 * `dg-skills prototype selection wait`.
 */

import { useCallback, useEffect, useState } from "react";

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
  /** Quick-pick reasons shown as chips in the (required) reject-note popup. */
  rejectReasons?: string[];
}

const DEFAULT_REJECT_REASONS = [
  "Doesn't fit the use case",
  "Too cluttered / busy",
  "Wrong layout or hierarchy",
  "None of these — go more radical",
  "Close, but needs tweaks",
];

const bar: React.CSSProperties = {
  position: "fixed",
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "linear-gradient(135deg,#1b2440 0%,#241a3a 55%,#3a1730 100%)",
  color: "#fff",
  borderRadius: 16,
  border: "1px solid rgba(120,140,255,.35)",
  padding: "8px 16px",
  boxShadow: "0 6px 28px rgba(60,40,120,.55)",
  fontFamily: "system-ui, sans-serif",
  fontSize: 14,
  userSelect: "none",
  whiteSpace: "nowrap",
};

const btn: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 8,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

const navBtn: React.CSSProperties = {
  ...btn,
  background: "linear-gradient(135deg,#4c8dff,#6f5cff)",
  border: "1px solid transparent",
  fontWeight: 700,
};

// Variant hue is picked by index (not key) so it works for any variant naming scheme.
const VARIANT_HUES = ["#4c8dff", "#a855f7", "#22c55e", "#f59e0b", "#f43f5e", "#14b8a6"];
const CONFETTI_COLORS = ["#22c55e", "#4c8dff", "#a855f7", "#f59e0b", "#f43f5e", "#14b8a6"];

const notesBtnStyle = (hasNotes: boolean, active: boolean): React.CSSProperties => ({
  ...btn,
  marginLeft: 8,
  fontWeight: 600,
  border: "1px solid transparent",
  background: hasNotes ? "linear-gradient(135deg,#0d9488,#14b8a6)" : "linear-gradient(135deg,#f59e0b,#f97316)",
  boxShadow: hasNotes ? "0 0 0 2px rgba(20,184,166,.55), 0 0 14px rgba(20,184,166,.4)" : "none",
  outline: active ? "2px solid rgba(255,255,255,.5)" : "none",
});

const approveBtn: React.CSSProperties = {
  ...btn,
  background: "linear-gradient(135deg,#16a34a,#22c55e)",
  border: "1px solid transparent",
  fontWeight: 700,
};

const rejectBtn: React.CSSProperties = {
  ...btn,
  background: "linear-gradient(135deg,#e11d48,#b45309)",
  border: "1px solid transparent",
  fontWeight: 700,
};

const notesPanel: React.CSSProperties = {
  position: "fixed",
  bottom: 80,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 9999,
  width: 420,
  maxWidth: "90vw",
  background: "#111",
  color: "#fff",
  borderRadius: 12,
  padding: 16,
  boxShadow: "0 4px 24px rgba(0,0,0,0.45)",
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
};

const notesArea: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#1b1b1b",
  color: "#fff",
  border: "1px solid #333",
  borderRadius: 6,
  padding: 8,
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
  resize: "vertical",
};

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

// Dev-only stylesheet for effects inline style objects can't express (@keyframes, :hover).
const SWITCHER_STYLE_ID = "ps-switcher-styles";
const SWITCHER_CSS = `
@keyframes burst { 0%{transform:translate(0,0) rotate(0);opacity:1} 100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot));opacity:0} }
@keyframes glow { 0%,100%{box-shadow:0 0 0 8px rgba(34,197,94,.16),0 10px 40px rgba(34,197,94,.35)} 50%{box-shadow:0 0 0 14px rgba(34,197,94,.06),0 10px 60px rgba(34,197,94,.6)} }
@keyframes pop { 0%{transform:scale(.3);opacity:0} 100%{transform:scale(1);opacity:1} }
@keyframes draw { to { stroke-dashoffset:0 } }
.ps-btn { transition: filter .15s ease, transform .15s ease; }
.ps-btn:hover { filter: brightness(1.18); transform: translateY(-1px); }
.ps-confetti-particle {
  position: fixed; top: 38vh; left: 50%; width: 10px; height: 14px;
  border-radius: 2px; pointer-events: none; z-index: 10001;
  animation: burst .9s ease-out forwards;
}
.ps-check-badge { animation: pop .4s ease, glow 2s ease-in-out .4s infinite; }
.ps-check-path { stroke-dasharray: 48; stroke-dashoffset: 48; animation: draw .5s .25s ease forwards; }
`;

const reworkBanner: React.CSSProperties = {
  position: "fixed",
  bottom: 80,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 9999,
  width: 460,
  maxWidth: "92vw",
  background: "#3a2a0a",
  color: "#fde68a",
  border: "1px solid #b45309",
  borderRadius: 12,
  padding: "10px 14px",
  boxShadow: "0 4px 24px rgba(0,0,0,0.45)",
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
  lineHeight: 1.4,
};

const rejectPanel: React.CSSProperties = {
  position: "fixed",
  bottom: 80,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 9999,
  width: 440,
  maxWidth: "92vw",
  background: "#111",
  color: "#fff",
  border: "1px solid #b45309",
  borderRadius: 12,
  padding: 16,
  boxShadow: "0 4px 24px rgba(0,0,0,0.45)",
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
};

const chip: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.25)",
  color: "#fff",
  borderRadius: 999,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.2,
};

const readMode = (): "light" | "dark" =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "dark"
    ? "dark"
    : "light";

// Tab favicon reflects whose turn it is: ⏳ waiting on the user's decision,
// 🔄 processing a rework, ✅ approved — visible at a glance across tabs.
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
  const [rejectOpen, setRejectOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [error, setError] = useState<string | null>(null);
  const [confetti, setConfetti] = useState<
    { id: number; dx: number; dy: number; rot: number; color: string; delay: number }[]
  >([]);

  // Append a quick-pick reason on its own line (skip if already present).
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

  // replaceState keeps the switcher functional without triggering a full navigation.
  // popstate lets host pages re-render without a hard reload.
  const go = useCallback((key: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", key);
    history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // Sync local mode from ?mode and reflect it as a `dark` class on <html>.
  useEffect(() => {
    const sync = () => {
      const m = readMode();
      setMode(m);
      document.documentElement.classList.toggle("dark", m === "dark");
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const toggleMode = useCallback(() => {
    const nextMode = readMode() === "dark" ? "light" : "dark";
    const url = new URL(window.location.href);
    url.searchParams.set("mode", nextMode);
    history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // Reflect decision state in the tab favicon (⏳ waiting · 🔄 processing · ✅ done)
  // so a prototype awaiting input is obvious at a glance. No-op in production.
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

  // Inject the keyframes/hover stylesheet once (inline style objects can't hold either).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (document.getElementById(SWITCHER_STYLE_ID)) return;
    const styleEl = document.createElement("style");
    styleEl.id = SWITCHER_STYLE_ID;
    styleEl.textContent = SWITCHER_CSS;
    document.head.appendChild(styleEl);
  }, []);

  // One-shot confetti burst when the confirm overlay appears.
  useEffect(() => {
    if (outcome !== "confirm") return;
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
  }, [outcome]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const editable = (e.target as HTMLElement).isContentEditable;
      // Don't steal arrow keys from form inputs.
      if (tag === "INPUT" || tag === "TEXTAREA" || editable) return;
      if (e.key === "ArrowLeft") go(prev);
      if (e.key === "ArrowRight") go(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, prev, next]);

  // Best-effort close — browsers honor it only for script-opened/single-history tabs
  // while a user gesture is live (see the beacon path in submit); overlay is the fallback.
  const closeTab = useCallback(() => {
    try {
      window.open("", "_self");
    } catch {}
    window.close();
  }, []);

  const submit = useCallback(
    (action: "confirm" | "reject") => {
      setError(null);
      // window.location.port is empty string on default ports (80/443) — fall back to origin directly
      const basePort = port ?? (window.location.port || undefined);
      const base = basePort
        ? `${window.location.protocol}//${window.location.hostname}:${basePort}`
        : window.location.origin;
      const url = `${base}${basePath}/prototype-confirm`;
      const payload = JSON.stringify({ name: prototypeName, variant: current, variants, notes, action });

      // Approve with empty notes is the only outcome that closes the tab — approve
      // with notes and reject both keep it open for the rework/iteration loop.
      const closeAfter = action === "confirm" && notes.trim().length === 0;

      // sendBeacon delivers without awaiting, so the click's user activation stays live
      // for window.close() — an awaited fetch loses it and the browser blocks the close.
      let queued = false;
      try {
        queued =
          typeof navigator.sendBeacon === "function" &&
          navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
      } catch {
        queued = false;
      }
      if (queued) {
        setOutcome(action);
        // 2.2s delay lets the confetti/overlay register first; if the browser blocks
        // window.close() (tab wasn't script-opened), the overlay is the fallback.
        if (closeAfter) window.setTimeout(closeTab, 2200);
        return;
      }

      // Fallback: beacon unavailable/refused. POST async (close is best-effort here).
      setSubmitting(true);
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload })
        .then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
            setSubmitting(false);
            return;
          }
          setOutcome(action);
          if (closeAfter) window.setTimeout(closeTab, 2200);
          else setSubmitting(false);
        })
        .catch(err => {
          setError(err instanceof Error ? err.message : "Network error");
          setSubmitting(false);
        });
    },
    [port, basePath, prototypeName, current, variants, notes, closeTab],
  );

  // Guard after all hooks — rules-of-hooks requires hooks to run unconditionally.
  if (process.env.NODE_ENV === "production") return null;

  if (outcome === "confirm") {
    return (
      <div style={overlay}>
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
        <div className="ps-check-badge" style={checkBadge}>
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
        <div style={{ fontSize: 24, fontWeight: 700 }}>Selected variant {current}</div>
        {notes.trim() && <div style={noteQuote}>"{notes.trim()}"</div>}
        <div style={{ fontSize: 16, opacity: 0.7 }}>
          {notes.trim()
            ? "Selection recorded — the agent will pick it up."
            : "Selection recorded — this tab will close automatically."}
        </div>
        <button type="button" className="ps-btn" style={btn} onClick={() => setOutcome(null)}>
          Keep exploring
        </button>
      </div>
    );
  }

  const label = labels?.[current];
  const hasNotes = notes.trim().length > 0;
  const hue = VARIANT_HUES[((idx % VARIANT_HUES.length) + VARIANT_HUES.length) % VARIANT_HUES.length];

  return (
    <>
      {outcome === "reject" && (
        <div style={reworkBanner}>
          <span style={{ fontWeight: 600 }}>⟲ Reworking options…</span> Your reject was sent
          {hasNotes ? " with notes" : ""}. Keep this tab open — it refreshes when new options are ready.
          <button type="button" className="ps-btn" style={{ ...btn, marginLeft: 10 }} onClick={() => setOutcome(null)}>
            Dismiss
          </button>
        </div>
      )}
      {rejectOpen && (
        <div style={rejectPanel}>
          <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 14 }}>
            Why reject variant <strong>{current}</strong>?{" "}
            <span style={{ fontWeight: 400, color: "#fca5a5" }}>(required — it's how I rework)</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {rejectReasons.map(r => (
              <button type="button" key={r} style={chip} onClick={() => addReason(r)}>
                + {r}
              </button>
            ))}
          </div>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Pick a reason above or type your own — e.g. 'omnibar is closest but keep Add as a real button'"
            rows={3}
            style={notesArea}
            // biome-ignore lint/a11y/noAutofocus: dev-only prototype affordance
            autoFocus
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button type="button" className="ps-btn" style={btn} onClick={() => setNotes("")} disabled={!notes.trim()}>
              Clear
            </button>
            <button type="button" className="ps-btn" style={btn} onClick={() => setRejectOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ps-btn"
              style={rejectBtn}
              disabled={submitting || !notes.trim()}
              onClick={() => {
                submit("reject");
                setRejectOpen(false);
              }}
            >
              Reject ⟲
            </button>
          </div>
          {error && <div style={{ color: "#f87171", marginTop: 6, fontSize: 12 }}>{error}</div>}
        </div>
      )}
      {notesOpen && (
        <div style={notesPanel}>
          <div style={{ marginBottom: 10, fontWeight: 600, fontSize: 14 }}>
            Notes for variant <strong>{current}</strong>
            {label && <span style={{ fontWeight: 400, opacity: 0.75 }}> — {label}</span>}
          </div>
          <label htmlFor="proto-notes" style={{ display: "block", marginBottom: 4, opacity: 0.7, fontSize: 12 }}>
            Optional — applies to whichever you click next, Approve or Reject
          </label>
          <textarea
            id="proto-notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. 'C outlines but keep Add filled like B', or for Reject: 'all too loud, try flatter neutral secondaries'"
            rows={3}
            style={notesArea}
            // biome-ignore lint/a11y/noAutofocus: dev-only prototype affordance
            autoFocus
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
            <button type="button" className="ps-btn" style={btn} onClick={() => setNotes("")} disabled={!hasNotes}>
              Clear
            </button>
            <button type="button" className="ps-btn" style={btn} onClick={() => setNotesOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
      <div style={bar}>
        <button type="button" className="ps-btn" style={btn} onClick={toggleMode} title="Toggle light/dark">
          {mode === "dark" ? "☀ Light" : "☾ Dark"}
        </button>
        <span style={{ width: 1, height: 18, background: "rgba(255,255,255,0.2)" }} />
        <button type="button" className="ps-btn" style={navBtn} onClick={() => go(prev)} title="Previous variant">
          ←
        </button>
        <span
          style={{
            minWidth: 90,
            maxWidth: 280,
            textAlign: "center",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            background: `${hue}22`,
            border: `1px solid ${hue}`,
            borderRadius: 999,
            padding: "4px 12px",
          }}
        >
          <span style={{ opacity: 0.6 }}>{prototypeName}</span>
          <span style={{ margin: "0 6px", opacity: 0.4 }}>·</span>
          <strong>{current}</strong>
          {label && <span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 6, fontSize: 12 }}>— {label}</span>}
        </span>
        <button type="button" className="ps-btn" style={navBtn} onClick={() => go(next)} title="Next variant">
          →
        </button>
        <span style={{ width: 1, height: 18, background: "rgba(255,255,255,0.2)", marginLeft: 4 }} />
        <button
          type="button"
          className="ps-btn"
          style={notesBtnStyle(hasNotes, notesOpen)}
          onClick={() => setNotesOpen(p => !p)}
          title="Add notes for your decision"
        >
          {hasNotes ? "📝 Note added ✓" : "📝 Notes"}
        </button>
        <button
          type="button"
          className="ps-btn"
          style={approveBtn}
          onClick={() => submit("confirm")}
          disabled={submitting}
          title="Approve this variant"
        >
          {submitting ? "…" : "Approve ✓"}
        </button>
        <button
          type="button"
          className="ps-btn"
          style={rejectBtn}
          onClick={() => setRejectOpen(p => !p)}
          disabled={submitting}
          title="Reject all — ask for new options (note required)"
        >
          {submitting ? "…" : "Reject ⟲"}
        </button>
        {error && <span style={{ color: "#f87171", marginLeft: 8, fontSize: 12 }}>{error}</span>}
      </div>
    </>
  );
}
