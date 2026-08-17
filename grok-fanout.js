export const meta = {
  name: 'grok-fanout',
  description: 'Grok-W fan-out: the orchestrator freezes specs, Grok Build CLI subagents (grok-4.6 at xhigh) do the implementation work in parallel, every item is judged by a structurally blind Grok verifier plus an independent diff review, and failures are re-planned.',
  phases: [
    { title: 'Plan', detail: 'orchestrator decomposes the goal into disjoint, frozen work items with proof commands' },
    { title: 'Spec', detail: 'adversarial spec pass — hunt ambiguity BEFORE Grok acts on it (Grok has zero context and will invent)' },
    { title: 'Build', detail: 'per item: Grok writer + structurally blind Grok verifier, resume loop, isolated worktree' },
    { title: 'Review', detail: 'independent diff review per item — reads the real diff, not the worker\'s claims' },
  ],
}

// ============================================================================
// grok-fanout — Grok does the work, the orchestrator does the thinking.
//
//   Orchestrator — whichever agent invoked this workflow; the model does not matter
//        |  plan, then harden the specs
//        |  fan out
//        v
//   Item 1 / Item 2 / Item 3 ...   each item:
//        Grok WRITER   (grok-fan.ps1, mode full, --permission-mode auto)
//        Grok VERIFIER (same wave, "after" the writer, mode shell, BLIND)
//        proof command re-run by the worker itself
//        resume loop on failure
//        |
//        v
//   Independent diff review (fresh agent, reads git diff, never the worker's claims)
//        |
//        v
//   Integrate — the calling session merges deliberately.
//
// Two gates exist because of what Grok measurably is (see SKILL.md): it emits
// schema-valid success reports for work it never performed, with stopReason
// "end_turn" and numTurns 1.
//
//   1. A structurally BLIND Grok verifier. It runs after the writer, in the same
//      worktree, and is never shown the writer's output — the runner does not feed
//      a dependency's result into a dependent prompt. It judges disk state and the
//      proof command only.
//   2. An independent diff review by a fresh agent that receives the SPEC and the
//      DIFF, and deliberately not the worker's self-report.
//
// Everything mechanical is Grok's. Everything that is a judgement stays above it.
//
// Invoke:
//   Workflow({ scriptPath: '<skill dir>/grok-fanout.js',
//              args: { goal, repo, runner?, maxWorkers?, maxRounds?, isolation?, specReview? } })
//
//   goal        (required) what to build / fix / refactor
//   repo        (default '.') repo root, relative to the session cwd
//   runner      absolute path to grok-fan.mjs. Required unless you filled in
//               RUNNER_DEFAULT below when you installed the skill.
//   maxWorkers  (default 6, cap 10) items per round — the runner throttles Grok at 10
//   maxRounds   (default 2) re-plan + re-dispatch rounds for failed items
//   isolation   'worktree' (default) or 'none'. 'none' is REQUIRED when the session
//               cwd is not a git repo — items then rely on disjoint "touches".
//   specReview  (default true) run the adversarial spec pass
//
// There is deliberately no argument for who orchestrates: the planning, spec and
// review agents inherit the calling session's model. Whoever runs the workflow
// orchestrates it.
// ============================================================================

// ---- install setting ------------------------------------------------------
// Absolute path to grok-fan.mjs, which lives next to this file. A Workflow script
// has no filesystem access and cannot discover its own location, so this cannot be
// derived at runtime. Fill it in once when you install the skill, or pass
// args.runner on every invocation.
//   e.g. '/home/you/.claude/skills/grok-w/grok-fan.mjs'
//   or   'C:\\Users\\you\\.claude\\skills\\grok-w\\grok-fan.mjs'
const RUNNER_DEFAULT = 'C:\\Users\\robin\\.claude\\skills\\grok-w\\grok-fan.mjs'

// Standing rule, not a tunable: Grok always runs as grok-4.6 at xhigh.
// xhigh is the top of grok's ladder — the CLI rejects 'max' with
// "unknown effort level 'max'; use one of: xhigh, high, medium, low".
// The runner pins the same values and refuses per-task overrides.
const GROK_MODEL = 'grok-4.6'
const GROK_EFFORT = 'xhigh'

// ---------- input ----------
const input = typeof args === 'string' ? { goal: args } : (args || {})
const goal = input.goal
const repo = input.repo || '.'
const RUNNER = input.runner || RUNNER_DEFAULT
const cap = Math.max(1, Math.min(input.maxWorkers || 6, 10))
const maxRounds = Math.max(1, input.maxRounds || 2)
const isolation = input.isolation === 'none' ? 'none' : 'worktree'
const specReview = input.specReview !== false

if (!goal) {
  log('grok-fanout needs a goal. Invoke with args:{ goal, repo?, maxWorkers?, ... } or args:"<goal string>".')
  return { error: 'no-goal' }
}

if (!RUNNER) {
  log('grok-fanout needs the absolute path to grok-fan.ps1. Set RUNNER_DEFAULT at the top of this script, or pass args.runner.')
  return { error: 'no-runner' }
}

// ---------- schemas ----------
const PLAN_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      description: 'Independent work items, buildable in parallel WITHOUT touching the same files.',
      items: {
        type: 'object',
        required: ['id', 'title', 'spec', 'proof', 'touches'],
        properties: {
          id: { type: 'string', description: 'short kebab-case id, filename-safe, e.g. "wallet-hook"' },
          title: { type: 'string' },
          spec: {
            type: 'string',
            description: 'Frozen, self-contained work order for a ZERO-CONTEXT implementer that cannot ask questions: goal, exact absolute paths, what to read first, constraints ("do not touch X"), non-goals, and the exact output shape. Anything left implicit will be invented.',
          },
          proof: {
            type: 'string',
            description: 'Exact shell command that PROVES the item is done (focused test / typecheck / build). Must be runnable from the repo root and must fail loudly when the work is wrong.',
          },
          touches: { type: 'array', items: { type: 'string' }, description: 'Files/dirs this item will modify — used to guarantee disjoint items.' },
          needsShell: { type: 'boolean', description: 'True if the implementer must run commands (tests, generators) and not just edit files.' },
        },
      },
    },
    conflictNote: { type: 'string', description: 'If the goal is NOT cleanly parallelizable, explain and return a single item.' },
  },
}

const WORKER_SCHEMA = {
  type: 'object',
  required: ['id', 'status', 'verdict', 'summary', 'proofOutput'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'failed'] },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description: 'pass ONLY if YOU ran the proof command and saw it green, AND the changes are really on disk.',
    },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'From git status / git diff --name-only — observed, not claimed by Grok.' },
    proofOutput: { type: 'string', description: 'Tail of the proof command output as YOU ran it. Evidence, not a claim.' },
    blindVerifierVerdict: { type: 'string', description: 'What the blind Grok verifier concluded, verbatim.' },
    grokTurns: { type: 'number', description: 'numTurns of the Grok writer run from _summary.json. 1 means it never called a tool.' },
    suspectFabrication: { type: 'boolean', description: 'True if the runner flagged suspectNoToolCall, or Grok claimed changes that were not on disk.' },
    rounds: { type: 'number', description: 'Grok resume rounds used.' },
    branch: { type: 'string' },
    grokCostUSD: { type: 'number' },
    notes: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['id', 'verdict', 'reasoning'],
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['accept', 'revise', 'reject'] },
    reasoning: { type: 'string' },
    inScope: { type: 'boolean', description: 'False if the diff changes things the spec did not ask for.' },
    meetsSpec: { type: 'boolean' },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'issue'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
      },
    },
  },
}

// ---------- prompts ----------
const planPrompt = (round, failures) => round === 1
  ? [
      `You are the ORCHESTRATOR. Decompose this goal into AT MOST ${cap} INDEPENDENT work items that can be built in parallel without touching the same files.`,
      ``,
      `GOAL:`,
      goal,
      ``,
      `REPO: ${repo}`,
      ``,
      `The implementer of each item is a Grok Build CLI subagent with ZERO context: it has never seen this`,
      `conversation, cannot ask questions, and — measured, not hypothetical — will invent a plausible`,
      `success report rather than admit an underspecified instruction. Write specs accordingly:`,
      `- absolute paths, never "the file above" or "as discussed"`,
      `- name what to read FIRST, so it grounds itself in the real code before editing`,
      `- state non-goals and "do not touch" explicitly`,
      `- the proof command must be exact and must FAIL loudly when the work is wrong; a proof that`,
      `  passes on an empty diff is worthless`,
      `- populate "touches"; items must be disjoint because they run concurrently`,
      `Explore the repo enough to make the paths and proof commands real. If the goal is not cleanly`,
      `parallelizable, return a SINGLE item and say so in conflictNote.`,
    ].join('\n')
  : [
      `You are the ORCHESTRATOR re-planning (round ${round}). These items FAILED. Re-spec ONLY them.`,
      ``,
      `ORIGINAL GOAL:`,
      goal,
      ``,
      `FAILURES — read the proof output and the review defects, and fix what the SPEC got wrong.`,
      `A failure caused by an ambiguous spec is your bug, not the implementer's:`,
      JSON.stringify(failures.map(f => ({
        id: f.id,
        summary: f.summary,
        proofOutput: f.proofOutput,
        suspectFabrication: f.suspectFabrication,
        blindVerifierVerdict: f.blindVerifierVerdict,
        reviewDefects: f.review && f.review.defects,
        reviewReasoning: f.review && f.review.reasoning,
      })), null, 2),
      ``,
      `Keep the same ids. Sharpen the specs; do not merely restate them.`,
    ].join('\n')

const specPrompt = (items) => [
  `You are an ADVERSARIAL SPEC REVIEWER. ${cap} Grok Build subagents are about to execute the specs below`,
  `in parallel, each with zero context and no ability to ask questions.`,
  ``,
  `Your job is to find every place a spec could be misread, then RETURN THE CORRECTED PLAN.`,
  `Hunt specifically for:`,
  `- paths that do not exist, or are relative where they must be absolute (check them against the repo)`,
  `- a proof command that would pass even if the implementer did nothing`,
  `- overlapping "touches" between items — they run concurrently and would clobber each other`,
  `- decisions left to the implementer that are really design decisions (naming, API shape, file layout)`,
  `- missing "read this first" grounding, which is what makes a zero-context model invent`,
  ``,
  `GOAL:`,
  goal,
  ``,
  `REPO: ${repo}`,
  ``,
  `PLAN TO HARDEN:`,
  JSON.stringify(items, null, 2),
  ``,
  `Verify paths and proof commands against the real repo before you answer. Return the full corrected`,
  `plan in the same schema — same ids, sharper specs. If an item is fine, return it unchanged.`,
].join('\n')

const workerPrompt = (item, round) => [
  `You are a grok-fanout WORKER. You do NOT write the implementation yourself — a Grok Build CLI subagent does`,
  `the typing. You dispatch it, you verify it, and you are the one who is accountable for the verdict.`,
  isolation === 'worktree'
    ? `You are running inside an ISOLATED git worktree of the repo. Everything below happens there; use "." as the repo root.`
    : `You are running in the repo directly (isolation disabled). Touch ONLY the paths listed under "Expected to touch".`,
  ``,
  `## Why you cannot take Grok's word for anything`,
  ``,
  `Measured on grok-4.6, not hypothetical: it returns schema-valid success reports for work it never did.`,
  `A write task reported the file and content it had "written" with stopReason "end_turn" while nothing`,
  `reached the disk. The mechanical tell is numTurns == 1 — a task that needed a tool call but took one turn`,
  `answered from prior knowledge. The runner surfaces this as suspectNoToolCall.`,
  ``,
  `## Step 1 — dispatch writer + blind verifier in ONE runner wave`,
  ``,
  `Write this task file (fill in the spec and proof), then run the runner once:`,
  ``,
  '```json',
  `[`,
  `  {`,
  `    "id": "${item.id}-write",`,
  `    "mode": "full",`,
  `    "cwd": "<absolute path of this worktree>",`,
  `    "maxTurns": 80,`,
  `    "prompt": "<the SPEC below, verbatim, plus: report the absolute path of every file you changed>"`,
  `  },`,
  `  {`,
  `    "id": "${item.id}-verify",`,
  `    "mode": "shell",`,
  `    "cwd": "<same absolute path>",`,
  `    "after": "${item.id}-write",`,
  `    "afterAny": true,`,
  `    "maxTurns": 40,`,
  `    "prompt": "<verifier prompt — see Step 2>",`,
  `    "schema": { "type": "object", "required": ["verdict", "evidence"], "properties": {`,
  `      "verdict": { "type": "string", "enum": ["pass", "fail"] },`,
  `      "evidence": { "type": "string" },`,
  `      "filesActuallyChanged": { "type": "array", "items": { "type": "string" } } } }`,
  `  }`,
  `]`,
  '```',
  ``,
  `Run it (one command, any platform):`,
  ``,
  '```',
  `node "${RUNNER}" --tasks-file "<workdir>/${item.id}.json" --out-dir "<workdir>/${item.id}-out" --default-cwd "<worktree>" --max-parallel 2`,
  '```',
  ``,
  `The runner defaults to --permission-mode auto, which is the ONLY mode where Grok's write and`,
  `run_terminal_command actually execute. Do not override it; it refuses writing modes under any other mode.`,
  `Model and effort are pinned inside the runner (${GROK_MODEL} at ${GROK_EFFORT}); there is nothing to pass.`,
  ``,
  `## Step 2 — the verifier must be BLIND`,
  ``,
  `The verifier prompt must contain ONLY: the repo path, the item's acceptance criteria restated from the spec,`,
  `and the exact proof command to run. It must NOT contain the writer's report, its file list, or its claims.`,
  `The runner never feeds a dependency's output into a dependent prompt, so blindness holds as long as you`,
  `do not paste it in yourself. Tell it: "Inspect the working tree and run the proof command. Judge only what`,
  `you can observe. Report fail if the work is absent, incomplete, or the proof command does not pass."`,
  ``,
  `## Step 3 — verify independently, then decide`,
  ``,
  `Read _summary.json FIRST. Then, yourself:`,
  `- "git status -sb" and "git diff" — read the FULL diff. Does it exist? Is it in scope?`,
  `- run the PROOF command yourself and capture its real output. Never report a proof you did not run.`,
  `- compare the writer's claimed file list against git. A claim with no matching change on disk means`,
  `  fabrication: set suspectFabrication true and treat the round as failed regardless of what it said.`,
  `- check numTurns and suspectNoToolCall in _summary.json for the "-write" task.`,
  ``,
  `## Step 4 — resume loop (max 2 rounds)`,
  ``,
  `If the proof fails, the diff is wrong, or the verifier said fail: re-dispatch the SAME Grok session with`,
  `a corrective prompt. Take sessionId from _summary.json and put it in the next task file as`,
  `"resumeSessionId" — resume keeps the session's context, so state only what is wrong and what to change.`,
  `Do not hand-fix beyond trivial (<20 lines). Stop after 2 failed rounds and report failed with the concrete reason.`,
  ``,
  isolation === 'worktree'
    ? `## Step 5 — commit\n\nCommit the changes on this worktree's branch. Do NOT push, merge, or touch GitHub — integration is the calling session's job. Report the branch from "git branch --show-current".`
    : `## Step 5 — leave the tree\n\nDo NOT commit, push or merge. Leave the changes in the working tree and report the changed paths; the calling session integrates.`,
  ``,
  `## Report`,
  ``,
  `verdict "pass" ONLY if you ran the proof command and saw it green AND the changes are really on disk.`,
  `Include the proof output as evidence, the blind verifier's verdict verbatim, grokTurns, and`,
  `grokCostUSD from _summary.json totalCostUSD.`,
  ``,
  `================ WORK ITEM ${item.id} — ${item.title} ================`,
  round > 1 ? `(re-planned, round ${round})` : '',
  ``,
  `SPEC — freeze this; hand it to Grok verbatim:`,
  item.spec,
  ``,
  `PROOF COMMAND:`,
  item.proof,
  ``,
  `Expected to touch: ${(item.touches || []).join(', ') || '(planner unspecified)'}`,
].filter(l => l !== '').join('\n')

const reviewPrompt = (item, branch) => [
  `You are an INDEPENDENT REVIEWER. Judge the implementation of one work item.`,
  ``,
  `You are deliberately NOT being shown the worker's self-report. Read the code.`,
  ``,
  branch
    ? `The changes are committed on branch "${branch}". Read the diff against the base branch, e.g.\n  git diff $(git merge-base HEAD ${branch})..${branch}\n(worktrees share the object store, so the branch is readable from the main repo).`
    : `The changes are uncommitted in the working tree of ${repo}. Read them with "git diff" and "git status -sb", or inspect the files directly if this is not a git repo.`,
  ``,
  `SPEC the implementation was supposed to satisfy:`,
  item.spec,
  ``,
  `PROOF COMMAND: ${item.proof}`,
  `Expected to touch: ${(item.touches || []).join(', ') || '(unspecified)'}`,
  ``,
  `Judge, as a contributor reviewing a PR:`,
  `- does the diff actually implement the spec, or does it only look like it does?`,
  `- is anything out of scope — files the spec never mentioned, drive-by refactors, unrelated formatting?`,
  `- run the proof command yourself and see it for real`,
  `- are there defects a passing test would not catch? error paths, boundaries, silent failure`,
  `- is there a stub, a TODO, a hardcoded value, or a test weakened to make things pass?`,
  ``,
  `verdict: "accept" (mergeable), "revise" (right direction, defects listed) or "reject" (wrong or absent).`,
  `An empty or near-empty diff is "reject", no matter what any report says.`,
].join('\n')

// ---------- orchestrator ----------
log(`grok-fanout: goal on ${repo} | workers=Grok ${GROK_MODEL}@${GROK_EFFORT} (pinned) | isolation=${isolation} | cap=${cap}`)

const accepted = []
let carry = []

for (let round = 1; round <= maxRounds; round++) {
  // ---- Plan ----
  phase('Plan')
  // No model override anywhere: every thinking agent inherits the calling session.
  const planOpts = { label: `plan:r${round}`, phase: 'Plan', schema: PLAN_SCHEMA }
  let plan = await agent(planPrompt(round, carry), planOpts)
  let items = (plan && plan.items ? plan.items : []).slice(0, cap)
  if (!items.length) { log(`Round ${round}: planner produced no items — stopping.`); break }
  if (round === 1 && plan.conflictNote) log(`Planner note: ${plan.conflictNote}`)

  // ---- Spec: harden before anything is dispatched ----
  if (specReview) {
    phase('Spec')
    const hardenOpts = { label: `spec:r${round}`, phase: 'Spec', schema: PLAN_SCHEMA }
    const hardened = await agent(specPrompt(items), hardenOpts)
    const hi = hardened && hardened.items ? hardened.items : []
    if (hi.length) {
      items = hi.slice(0, cap)
      log(`Specs hardened: ${items.length} item(s) — ${items.map(i => i.id).join(', ')}`)
    } else {
      log('Spec pass returned nothing usable — proceeding with the original plan.')
    }
  }

  log(`Round ${round}: dispatching ${items.length} item(s) → ${items.map(i => i.id).join(', ')}`)

  // ---- Build + Review, pipelined: an item's review starts as soon as it is built ----
  const results = await pipeline(
    items,
    (item) => {
      const o = { label: `grok:${item.id}`, phase: 'Build', schema: WORKER_SCHEMA }
      if (isolation === 'worktree') o.isolation = 'worktree'
      return agent(workerPrompt(item, round), o)
    },
    (worker, item) => {
      // No worker result (skipped or died) — nothing to review; carry the item directly.
      if (!worker) return { item, worker: null, review: null }
      // The reviewer gets the item and the branch — never the worker's claims.
      const o = { label: `review:${item.id}`, phase: 'Review', schema: REVIEW_SCHEMA }
      return agent(reviewPrompt(item, worker.branch), o)
        .then(review => ({ item, worker, review: review || null }))
    }
  )

  const clean = results.filter(Boolean)
  carry = []
  for (const r of clean) {
    const workerPassed = r.worker && r.worker.verdict === 'pass' && !r.worker.suspectFabrication
    const reviewOk = r.review && r.review.verdict === 'accept'
    if (workerPassed && reviewOk) {
      accepted.push(r)
    } else {
      carry.push({
        id: r.item.id,
        summary: r.worker ? r.worker.summary : 'worker produced no result',
        proofOutput: r.worker ? r.worker.proofOutput : '',
        suspectFabrication: r.worker ? r.worker.suspectFabrication : null,
        blindVerifierVerdict: r.worker ? r.worker.blindVerifierVerdict : '',
        review: r.review,
        spec: r.item.spec,
        proof: r.item.proof,
      })
    }
    if (r.worker && r.worker.suspectFabrication) {
      log(`!! ${r.item.id}: fabrication suspected (grokTurns=${r.worker.grokTurns}) — round discarded.`)
    }
  }

  if (!carry.length) { log(`Round ${round}: all ${clean.length} item(s) accepted ✓`); break }
  if (round < maxRounds) log(`Round ${round}: ${carry.length} item(s) not accepted — re-planning.`)
  else log(`Round ${round}: ${carry.length} item(s) still unresolved after ${maxRounds} round(s).`)
}

const grokSpend = accepted.reduce((s, r) => s + (r.worker && r.worker.grokCostUSD ? r.worker.grokCostUSD : 0), 0)

log(`grok-fanout done: ${accepted.length} accepted, ${carry.length} unresolved. Grok spend on accepted items: $${grokSpend.toFixed(4)}`)

return {
  goal,
  grokModel: GROK_MODEL,
  grokEffort: GROK_EFFORT,
  isolation,
  accepted: accepted.map(r => ({
    id: r.item.id,
    title: r.item.title,
    branch: r.worker && r.worker.branch,
    filesChanged: r.worker && r.worker.filesChanged,
    proofOutput: r.worker && r.worker.proofOutput,
    grokTurns: r.worker && r.worker.grokTurns,
    review: r.review,
  })),
  unresolved: carry,
  branchesToReview: accepted.map(r => r.worker && r.worker.branch).filter(Boolean),
  advice: isolation === 'worktree'
    ? 'Each accepted item is committed on its own worktree branch. Read every diff and merge deliberately — grok-fanout never merges or pushes.'
    : 'Changes are uncommitted in the working tree. Review the full diff before committing; items were kept disjoint by the planner, not by git.',
}

