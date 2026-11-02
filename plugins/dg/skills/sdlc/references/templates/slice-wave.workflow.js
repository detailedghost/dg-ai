export const meta = {
  name: "sdlc-slice-wave",
  description: "Build one dependency layer of slices in parallel: Red→Yellow→Green→MiniQA→Correction. No commits.",
  // Progress groups are per-slice (one box per slice, labelled `<name> (S<id>)`),
  // created at runtime from slice names — so this static list is informational only.
  phases: [{ title: "slices", detail: "each slice runs Red→Yellow→Green→MiniQA in parallel" }],
};

/**
 * args (resolved by `dg-skills assign resolve`, which also bakes them in as WAVE_ARGS below the meta literal;
 * an explicit `args` wins when given — see ../engineering.md 4.2):
 *   slices   [{ id, name, primary, qa:[], proxyBackend, proxyFlags, brief, testingCriteria }]
 *            — ONE dependency layer; slices MUST touch disjoint files (name → progress label).
 *            primary and each qa entry are resolved { agentType, model, effort } stages.
 *            proxyBackend ← slices[].agents.proxy; set only when this slice's Yellow/Correction stages delegate via /proxy.
 *   roles    { "qa-writer", wave, security }  resolved stages shared by every slice in the layer.
 *            optional files: string[] — the slice's globs; recovered git paths outside them are dropped.
 *            optional notes: string — orchestrator text placed under a heading in THIS slice's prompts only.
 *   specPath, scratchPath  paths agents may read/append (passed into prompts)
 *   cwd      the worktree; when set, a stage lists its actual changes (git diff + untracked) into the review list.
 *   resolved string[]  deferral text prefixes the orchestrator already settled; matching SPEC/TEST items do not block.
 *   redDone  { [sliceId]: string[] }  test files from a finished red stage; that slice skips red and yellow gets these.
 *   templates { red, yellow, green, wave, correction, proxy }  inlined template bodies with tokens:
 *            {SLICE_ID} {SLICE_BRIEF} {TESTING_CRITERIA} {CHANGED_FILES} {FINDINGS}
 *            {SPEC_PATH} {SCRATCH_PATH} {PROXY_BACKEND} {PRIMARY_AGENT} {PROXY_FLAGS}
 *            `proxy` is undefined/omitted when no slice in this layer sets proxyBackend.
 *   maxCorrectionRounds  default 2
 */
// harness sometimes delivers args as a JSON string instead of a parsed object
const given = typeof args === "string" ? (args ? JSON.parse(args) : null) : args;
const _args = given && Object.keys(given).length ? given : typeof WAVE_ARGS === "undefined" ? {} : WAVE_ARGS;
const {
  slices = [],
  roles = {},
  specPath = "",
  scratchPath = "",
  cwd = "",
  templates = {},
  resolved = [],
  redDone = {},
  maxCorrectionRounds = 2,
} = _args;

const NOTES = {
  type: "object",
  properties: {
    durable: { type: "array", items: { type: "string" }, description: "[NOTE-DURABLE] entries" },
    scratch: { type: "array", items: { type: "string" }, description: "[NOTE-SCRATCH] entries" },
  },
};
const DEFERRALS = {
  type: "array",
  description: "items needing the human orchestrator — do NOT resolve them yourself",
  items: {
    type: "object",
    required: ["type", "text"],
    properties: { type: { enum: ["SPEC", "TEST", "CONFIRM", "CRITICAL"] }, text: { type: "string" } },
  },
};

const RED = {
  type: "object",
  required: ["testFiles", "deferrals"],
  properties: { testFiles: { type: "array", items: { type: "string" } }, deferrals: DEFERRALS, notes: NOTES },
};
const YELLOW = {
  type: "object",
  required: ["changedFiles", "testsPass", "deferrals"],
  properties: {
    changedFiles: { type: "array", items: { type: "string" } },
    testsPass: { type: "boolean" },
    attempts: { type: "integer" },
    securitySensitive: { type: "boolean", description: "touches auth/crypto/session/token/exec/eval/.env/routes/deps" },
    deferrals: DEFERRALS,
    notes: NOTES,
  },
};
const GREEN = {
  type: "object",
  required: ["testFiles", "deferrals"],
  properties: { testFiles: { type: "array", items: { type: "string" } }, deferrals: DEFERRALS, notes: NOTES },
};
const QA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "issue"],
        properties: {
          severity: { enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
          file: { type: "string" },
          issue: { type: "string" },
          owner: { enum: ["engineering", "qa-writer"] },
        },
      },
    },
  },
};

const FILES = {
  type: "object",
  required: ["files"],
  properties: { files: { type: "array", items: { type: "string" } } },
};

const sub = (tpl, slice, extra = {}) =>
  ((tpl || "")
    .replaceAll("{SLICE_ID}", String(slice.id))
    .replaceAll("{SLICE_BRIEF}", slice.brief || "")
    .replaceAll("{TESTING_CRITERIA}", slice.testingCriteria || "")
    .replaceAll("{SPEC_PATH}", specPath)
    .replaceAll("{SCRATCH_PATH}", scratchPath)
    .replaceAll("{CHANGED_FILES}", (extra.changedFiles || []).join("\n"))
    .replaceAll("{FINDINGS}", extra.findings || "")
    .replaceAll("{PROXY_BACKEND}", slice.proxyBackend || "")
    .replaceAll("{PRIMARY_AGENT}", bareAgent(slice.primary.agentType))
    .replaceAll("{PROXY_FLAGS}", slice.proxyFlags || "")) +
  (slice.notes ? `\n\nOrchestrator notes for this slice:\n${slice.notes}` : "");

const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const settled = (d) => resolved.some((prefix) => String(d.text || "").startsWith(prefix));
const gated = (d) => d.type === "SPEC" || d.type === "TEST";
const live = (ds) => (ds || []).filter((d) => !(gated(d) && settled(d)));
const blockingDeferral = (ds) => live(ds).some(gated);
const globRe = (glob) =>
  new RegExp(
    `^${glob
      .replace(/^\.\//, "")
      .replace(/\\(.)/g, (_, c) => `\u0002${c.charCodeAt(0)};`)
      .replace(/[.+^$()|\\]/g, "\\$&")
      .replace(/\*\*\//g, "\0")
      .replace(/\*\*/g, "\u0001")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\[!/g, "[^")
      .replace(/\{([^}]*)\}/g, (_, alts) => `(?:${alts.replaceAll(",", "|")})`)
      .replace(/\0/g, "(?:.*/)?")
      .replace(/\u0001/g, ".*")
      .replace(/\u0002(\d+);/g, (_, code) => `\\u${Number(code).toString(16).padStart(4, "0")}`)}$`,
  );
const safePath = (f) => {
  if (typeof f !== "string" || f.startsWith("/")) return null;
  const parts = f.split("/");
  if (parts.includes("..")) return null;
  return parts.filter((p) => p !== "" && p !== ".").join("/") || null;
};
const safePaths = (fs) => uniq((fs || []).map(safePath));
const ownedBy = (slice, f) =>
  !slice.files?.length ||
  slice.files.some((g) => globRe(g).test(f) || f.startsWith(`${g.replace(/^\.\//, "").replace(/\/$/, "")}/`));
const ownedPaths = (slice, fs) => safePaths(fs).filter((f) => ownedBy(slice, f));

// Per-slice progress group: one box per slice (stage stays visible via each agent's label).
const phaseFor = (slice) => (slice.name ? `${slice.name} (S${slice.id})` : `slice ${slice.id}`);

const bareAgent = (a) => a.replace(/^dg:/, "");
const stageOpts = (stage) => ({
  agentType: stage.agentType,
  effort: stage.effort,
  ...(stage.model ? { model: stage.model } : {}),
});

const results = await pipeline(
  slices,
  // 6a Red
  (slice) =>
    Object.hasOwn(redDone, slice.id)
      ? {
          slice,
          red: null,
          blocked: false,
          unverified: [],
          changedFiles: [...redDone[slice.id]],
          deferrals: [],
          notes: { durable: [], scratch: [] },
        }
      : agent(sub(templates.red, slice), {
      label: `red:${slice.id}`,
      phase: phaseFor(slice),
      ...stageOpts(roles["qa-writer"]),
      schema: RED,
    }).then((r) => ({
      slice,
      red: r,
      blocked: blockingDeferral(r?.deferrals),
      // `|| []` alone makes a dead agent's "produced nothing" read as "had nothing to add" —
      // which is how a wave of dead agents reported clean.
      unverified: r ? [] : ["red"],
      changedFiles: [...(r?.testFiles || [])],
      deferrals: live(r?.deferrals),
      notes: { durable: [...(r?.notes?.durable || [])], scratch: [...(r?.notes?.scratch || [])] },
    })),
  // 6b Yellow
  (st) => {
    if (st.blocked) return st;
    const slice = st.slice;
    // Proxy delegation swaps the template (persona/tier below are unchanged); falls back to templates.yellow
    // if the orchestrator forgot to inline templates.proxy, instead of silently sending an empty prompt.
    const yellowTpl = (slice.proxyBackend && templates.proxy) || templates.yellow;
    return agent(sub(yellowTpl, slice, { changedFiles: st.changedFiles }), {
      label: `yellow:${slice.id}`,
      phase: phaseFor(slice),
      ...stageOpts(slice.primary),
      schema: YELLOW,
    }).then((y) => ({
      ...st,
      yellow: y,
      blocked: blockingDeferral(y?.deferrals),
      // A dead implementation agent is the worst case: zero changedFiles means MiniQA reviews
      // nothing, finds nothing, and the slice reports clean with no code written.
      unverified: [...st.unverified, ...(y ? [] : ["yellow"])],
      securitySensitive: !!y?.securitySensitive,
      changedFiles: uniq([...st.changedFiles, ...ownedPaths(slice, y?.changedFiles)]),
      deferrals: [...st.deferrals, ...live(y?.deferrals)],
      notes: {
        durable: uniq([...st.notes.durable, ...(y?.notes?.durable || [])]),
        scratch: uniq([...st.notes.scratch, ...(y?.notes?.scratch || [])]),
      },
    }));
  },
  // 6c Green
  (st) => {
    if (st.blocked) return st;
    const slice = st.slice;
    return agent(sub(templates.green, slice, { changedFiles: st.changedFiles }), {
      label: `green:${slice.id}`,
      phase: phaseFor(slice),
      ...stageOpts(roles["qa-writer"]),
      schema: GREEN,
    }).then(async (g) => {
      const reported = uniq([...st.changedFiles, ...safePaths(g?.testFiles)]);
      const listed = cwd
        ? await agent(
            `Working directory: ${cwd}. Run these two commands from it and return every path they print, one entry per path, nothing else. Do not edit any file.\n1. git diff --name-only HEAD\n2. git ls-files --others --exclude-standard`,
            { label: `files:${slice.id}`, phase: phaseFor(slice), ...stageOpts(roles.wave), schema: FILES },
          )
        : null;
      const owned = ownedPaths(slice, listed?.files);
      return {
        ...st,
        unverified: [...st.unverified, ...(g ? [] : ["green"]), ...(cwd && !listed ? ["files"] : [])],
        changedFiles: uniq([...reported, ...(slice.files?.length ? owned : [])]),
        reviewFiles: uniq([...reported, ...owned]),
        deferrals: [...st.deferrals, ...live(g?.deferrals)],
        notes: {
          durable: uniq([...st.notes.durable, ...(g?.notes?.durable || [])]),
          scratch: uniq([...st.notes.scratch, ...(g?.notes?.scratch || [])]),
        },
      };
    });
  },
  // 6d MiniQA + 6e Correction (≤ maxCorrectionRounds)
  async (st) => {
    if (st.blocked)
      return {
        sliceId: st.slice.id,
        status: "blocked",
        changedFiles: st.changedFiles,
        deferrals: st.deferrals,
        unverifiedStages: st.unverified,
        notes: st.notes,
        summary: "blocked on deferral — orchestrator must resolve",
      };
    const slice = st.slice;
    const reviewers = [roles.wave, ...(slice.qa || []), st.securitySensitive ? roles.security : null]
      .filter(Boolean)
      .filter((rv, i, all) => all.findIndex((other) => other.agentType === rv.agentType) === i);
    const reviewerNames = reviewers.map((rv) => bareAgent(rv.agentType));
    let residual = [];
    let correctionDeferrals = [];
    let deadReviewers = [];
    let round = 0;
    while (round <= maxCorrectionRounds) {
      const reviews = await parallel(
        reviewers.map(
          (rv) => () =>
            agent(sub(templates.wave, slice, { changedFiles: st.reviewFiles || st.changedFiles }), {
              label: `${bareAgent(rv.agentType)}:${slice.id}#${round}`,
              phase: phaseFor(slice),
              ...stageOpts(rv),
              schema: QA,
            }),
        ),
      );
      // Which reviewers returned nothing at all, before filter(Boolean) makes them indistinguishable
      // from reviewers that returned no findings.
      deadReviewers = reviewerNames.filter((_, i) => !reviews[i]);
      residual = reviews.filter(Boolean).flatMap((r) => r.findings || []);
      if (!residual.length || round === maxCorrectionRounds) break;
      round++;
      const byOwner = { engineering: [], "qa-writer": [] };
      for (const f of residual) (byOwner[f.owner === "qa-writer" ? "qa-writer" : "engineering"] ||= []).push(f);
      const fixes = await parallel(
        Object.entries(byOwner)
          .filter(([, fs]) => fs.length)
          .map(([owner, fs]) => () => {
            // Proxy delegation only replaces engineering's template — QA-writer corrections always stay internal.
            const correctionTpl =
              (owner !== "qa-writer" && slice.proxyBackend && templates.proxy) || templates.correction;
            return agent(
              sub(correctionTpl, slice, {
                changedFiles: st.reviewFiles || st.changedFiles,
                findings: fs.map((f) => `[${f.severity}] ${f.file}: ${f.issue}`).join("\n"),
              }),
              {
                label: `fix:${owner}:${slice.id}#${round}`,
                phase: phaseFor(slice),
                ...stageOpts(owner === "qa-writer" ? roles["qa-writer"] : slice.primary),
                schema: YELLOW,
              },
            );
          }),
      );
      correctionDeferrals.push(...fixes.filter(Boolean).flatMap((fix) => live(fix.deferrals)));
      if (blockingDeferral(correctionDeferrals))
        return {
          sliceId: slice.id,
          status: "blocked",
          changedFiles: st.changedFiles,
          deferrals: [...st.deferrals, ...correctionDeferrals],
          residualFindings: residual,
          unverifiedStages: st.unverified,
          notes: st.notes,
          summary: "blocked on correction deferral — orchestrator must resolve",
        };
    }
    const escalate = residual.filter(
      (f) => f.severity === "CRITICAL" || (f.severity === "HIGH" && reviewerNames.includes(bareAgent(roles.security.agentType))),
    );
    // Three-state, and `unverified` outranks the rest: "clean" must mean every stage produced
    // evidence, not merely that no surviving reviewer complained.
    const unverifiedStages = uniq([...st.unverified, ...deadReviewers]);
    const status = unverifiedStages.length ? "unverified" : residual.length ? "needs-attention" : "clean";
    return {
      sliceId: slice.id,
      status,
      changedFiles: st.changedFiles,
      deferrals: [...st.deferrals, ...correctionDeferrals, ...escalate.map((f) => ({ type: "CRITICAL", text: `${f.file}: ${f.issue}` }))],
      residualFindings: residual,
      unverifiedStages,
      notes: st.notes,
      summary: unverifiedStages.length
        ? `UNVERIFIED — no result from: ${unverifiedStages.join(", ")}${residual.length ? `; ${residual.length} finding(s) from the rest` : ""}`
        : residual.length
          ? `${residual.length} residual finding(s) after ${round} round(s)`
          : "mini QA clean",
    };
  },
);

// A slice whose pipeline threw drops to null. Naming it beats reporting a short list of
// successes as if it were the whole run.
const droppedSlices = slices.filter((_, i) => !results[i]).map((s) => s.id);
if (droppedSlices.length) log(`UNVERIFIED: no result at all for slice(s) ${droppedSlices.join(", ")}`);
return { slices: results.filter(Boolean), droppedSlices }
