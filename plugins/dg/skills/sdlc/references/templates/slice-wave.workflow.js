export const meta = {
  name: "sdlc-slice-wave",
  description: "Build one dependency layer of slices in parallel: Red→Yellow→Green→MiniQA→Correction. No commits.",
  // Progress groups are per-slice (one box per slice, labelled `<name> (S<id>)`),
  // created at runtime from slice names — so this static list is informational only.
  phases: [{ title: "slices", detail: "each slice runs Red→Yellow→Green→MiniQA in parallel" }],
};

/**
 * args (built by the /sdlc orchestrator — see ../engineering.md 4.2; /spec + /pickup delegate here):
 *   slices   [{ id, name, primaryAgent, primaryEffort, proxyBackend, qaAgents:[], brief, testingCriteria }]
 *            — ONE dependency layer; slices MUST touch disjoint files (name → progress label).
 *            primaryEffort (low|medium|xhigh) ← slices[].agents.effort from /assign; falls back
 *            to primaryAgent's Delegation-table default when unset.
 *            proxyBackend ← slices[].agents.proxy from /assign; absent for the common case — only
 *            set when this slice's Yellow/Correction (engineering side) stages delegate via /proxy.
 *   specPath, scratchPath  paths agents may read/append (passed into prompts)
 *   templates { red, yellow, green, wave, correction, proxy }  inlined template bodies with tokens:
 *            {SLICE_ID} {SLICE_BRIEF} {TESTING_CRITERIA} {CHANGED_FILES} {FINDINGS}
 *            {SPEC_PATH} {SCRATCH_PATH} {PROXY_BACKEND} {PRIMARY_AGENT}
 *            `proxy` is undefined/omitted when no slice in this layer sets proxyBackend.
 *   maxCorrectionRounds  default 2
 *   model, effort   optional overrides applied to every stage in this layer (model: haiku|sonnet|opus,
 *            effort: low|medium|xhigh). Source: the spec's `## Execution` pin. Omit for the tier defaults.
 */
// harness sometimes delivers args as a JSON string instead of a parsed object
const _args = typeof args === "string" ? (args ? JSON.parse(args) : {}) : args || {};
const {
  slices = [],
  specPath = "",
  scratchPath = "",
  templates = {},
  maxCorrectionRounds = 2,
  model: modelOverride = "",
  effort: effortOverride = "",
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
    properties: { type: { enum: ["SPEC", "TEST", "CRITICAL"] }, text: { type: "string" } },
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

const sub = (tpl, slice, extra = {}) =>
  (tpl || "")
    .replaceAll("{SLICE_ID}", String(slice.id))
    .replaceAll("{SLICE_BRIEF}", slice.brief || "")
    .replaceAll("{TESTING_CRITERIA}", slice.testingCriteria || "")
    .replaceAll("{SPEC_PATH}", specPath)
    .replaceAll("{SCRATCH_PATH}", scratchPath)
    .replaceAll("{CHANGED_FILES}", (extra.changedFiles || []).join("\n"))
    .replaceAll("{FINDINGS}", extra.findings || "")
    .replaceAll("{PROXY_BACKEND}", slice.proxyBackend || "")
    .replaceAll("{PRIMARY_AGENT}", bareAgent(slice.primaryAgent || "general-purpose"));

const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const blockingDeferral = (ds) => (ds || []).some((d) => d.type === "SPEC" || d.type === "TEST");

// Per-slice progress group: one box per slice (stage stays visible via each agent's label).
const phaseFor = (slice) => (slice.name ? `${slice.name} (S${slice.id})` : `slice ${slice.id}`);

// Tier the fan-out (unpinned workflow agents else inherit session Opus). Mirrors each named
// agent's own frontmatter pin (its agent definition file) since opts.model overrides it here.
const PLUGIN_AGENTS = new Set([
  "arch",
  "checkpoint",
  "copilot-antagonist",
  "csharp",
  "dba",
  "design",
  "devops",
  "foreman",
  "js",
  "lore",
  "python",
  "qa-code",
  "qa-devops",
  "qa-perf",
  "qa-writer",
  "reviewer",
  "security",
  "shell",
  "thrash",
  "wave",
]);
const bareAgent = (a) => a.replace(/^dg:/, "");
const typeFor = (a) => (PLUGIN_AGENTS.has(bareAgent(a)) ? `dg:${bareAgent(a)}` : a);
const FABLE_AGENTS = new Set(["arch", "design", "foreman"]);
const OPUS_AGENTS = new Set(["dba", "security"]);
const modelFor = (a) => {
  const name = bareAgent(a);
  return (
    modelOverride ||
    (name === "wave" ? "haiku" : FABLE_AGENTS.has(name) ? "fable" : OPUS_AGENTS.has(name) ? "opus" : "sonnet")
  );
};
// Delegation-table effort default per model tier; primaryEffort from /assign wins when set.
const EFFORT_BY_MODEL = { haiku: "low", sonnet: "medium", opus: "xhigh", fable: "medium" };
const effortFor = (a, override) => override || effortOverride || EFFORT_BY_MODEL[modelFor(a)];

const results = await pipeline(
  slices,
  // 6a Red
  (slice) =>
    agent(sub(templates.red, slice), {
      label: `red:${slice.id}`,
      phase: phaseFor(slice),
      model: modelFor("qa-writer"),
      effort: effortFor("qa-writer"),
      agentType: typeFor("qa-writer"),
      schema: RED,
    }).then((r) => ({
      slice,
      red: r,
      blocked: blockingDeferral(r?.deferrals),
      // `|| []` alone makes a dead agent's "produced nothing" read as "had nothing to add" —
      // which is how a wave of dead agents reported clean.
      unverified: r ? [] : ["red"],
      changedFiles: [...(r?.testFiles || [])],
      deferrals: [...(r?.deferrals || [])],
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
      model: modelFor(slice.primaryAgent || "general-purpose"),
      effort: effortFor(slice.primaryAgent || "general-purpose", slice.primaryEffort),
      agentType: typeFor(slice.primaryAgent || "general-purpose"),
      schema: YELLOW,
    }).then((y) => ({
      ...st,
      yellow: y,
      blocked: blockingDeferral(y?.deferrals),
      // A dead implementation agent is the worst case: zero changedFiles means MiniQA reviews
      // nothing, finds nothing, and the slice reports clean with no code written.
      unverified: [...st.unverified, ...(y ? [] : ["yellow"])],
      securitySensitive: !!y?.securitySensitive,
      changedFiles: uniq([...st.changedFiles, ...(y?.changedFiles || [])]),
      deferrals: [...st.deferrals, ...(y?.deferrals || [])],
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
      model: modelFor("qa-writer"),
      effort: effortFor("qa-writer"),
      agentType: typeFor("qa-writer"),
      schema: GREEN,
    }).then((g) => ({
      ...st,
      unverified: [...st.unverified, ...(g ? [] : ["green"])],
      changedFiles: uniq([...st.changedFiles, ...(g?.testFiles || [])]),
      deferrals: [...st.deferrals, ...(g?.deferrals || [])],
      notes: {
        durable: uniq([...st.notes.durable, ...(g?.notes?.durable || [])]),
        scratch: uniq([...st.notes.scratch, ...(g?.notes?.scratch || [])]),
      },
    }));
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
    const reviewers = uniq(["wave", ...(slice.qaAgents || []), st.securitySensitive ? "security" : null].map((a) => a && bareAgent(a)));
    let residual = [];
    let deadReviewers = [];
    let round = 0;
    while (round <= maxCorrectionRounds) {
      const reviews = await parallel(
        reviewers.map(
          (rv) => () =>
            agent(sub(templates.wave, slice, { changedFiles: st.changedFiles }), {
              label: `${rv}:${slice.id}#${round}`,
              phase: phaseFor(slice),
              model: modelFor(rv),
              effort: effortFor(rv),
              agentType: typeFor(rv),
              schema: QA,
            }),
        ),
      );
      // Which reviewers returned nothing at all, before filter(Boolean) makes them indistinguishable
      // from reviewers that returned no findings.
      deadReviewers = reviewers.filter((_, i) => !reviews[i]);
      residual = reviews.filter(Boolean).flatMap((r) => r.findings || []);
      if (!residual.length || round === maxCorrectionRounds) break;
      round++;
      const byOwner = { engineering: [], "qa-writer": [] };
      for (const f of residual) (byOwner[f.owner === "qa-writer" ? "qa-writer" : "engineering"] ||= []).push(f);
      await parallel(
        Object.entries(byOwner)
          .filter(([, fs]) => fs.length)
          .map(([owner, fs]) => () => {
            // Proxy delegation only replaces engineering's template — QA-writer corrections always stay internal.
            const correctionTpl =
              (owner !== "qa-writer" && slice.proxyBackend && templates.proxy) || templates.correction;
            return agent(
              sub(correctionTpl, slice, {
                changedFiles: st.changedFiles,
                findings: fs.map((f) => `[${f.severity}] ${f.file}: ${f.issue}`).join("\n"),
              }),
              {
                label: `fix:${owner}:${slice.id}#${round}`,
                phase: phaseFor(slice),
                model: modelFor(owner === "qa-writer" ? "qa-writer" : slice.primaryAgent || "general-purpose"),
                effort: effortFor(
                  owner === "qa-writer" ? "qa-writer" : slice.primaryAgent || "general-purpose",
                  owner === "qa-writer" ? undefined : slice.primaryEffort,
                ),
                agentType: typeFor(owner === "qa-writer" ? "qa-writer" : slice.primaryAgent || "general-purpose"),
                schema: YELLOW,
              },
            );
          }),
      );
    }
    const escalate = residual.filter(
      (f) => f.severity === "CRITICAL" || (f.severity === "HIGH" && reviewers.includes("security")),
    );
    // Three-state, and `unverified` outranks the rest: "clean" must mean every stage produced
    // evidence, not merely that no surviving reviewer complained.
    const unverifiedStages = uniq([...st.unverified, ...deadReviewers]);
    const status = unverifiedStages.length ? "unverified" : residual.length ? "needs-attention" : "clean";
    return {
      sliceId: slice.id,
      status,
      changedFiles: st.changedFiles,
      deferrals: [...st.deferrals, ...escalate.map((f) => ({ type: "CRITICAL", text: `${f.file}: ${f.issue}` }))],
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
