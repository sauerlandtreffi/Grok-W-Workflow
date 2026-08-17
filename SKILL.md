---
name: grok-w
description: Grok-W — Grok Build CLI subagents do the labour (always grok-4.6 at xhigh, never another model or effort) while the invoking agent orchestrates and owns every judgement. Use whenever the user's message contains "Grok-W", "grok-w", "GrokW" or "/grok-w", in any casing, anywhere in the message. Shapes: single call, parallel wave of up to 10 tasks via grok-fan.ps1, or the grok-fanout pipeline (Workflow tool).
---

# Grok-W — orchestrated Grok fan-out

**Trigger:** any message containing `Grok-W` (any casing). Typing it *is* the opt-in — run the protocol, don't ask.

**Orchestrator:** whoever invoked this skill — you. You scope, decompose, freeze specs, verify and integrate. Grok subagents read, implement from frozen specs, and run narrowly scoped commands — they never judge their own work. **A Grok result is a proposal, never a fact.** Fan out wide; spend your own intelligence on the spec going in and the diff coming out.

`grok-fan.ps1` (runner) and `grok-fanout.js` (Workflow pipeline) live in this SKILL.md's directory (`<skill dir>` below).

## Map

```
ORCHESTRATOR (you) · scope → decompose → freeze specs → dispatch → verify → integrate
  │
  ├─ Shape 1 · single call     one-task wave — still gives _summary, suspect flag, sessionId
  ├─ Shape 2 · swarm wave      ≤10 disjoint tasks, dependency-ordered — the workhorse
  └─ Shape 3 · fanout pipeline (Workflow tool only) plan → harden specs
                               → per item: Grok writer → blind Grok verifier → proof
                               → independent diff review → accept / re-plan (≤2 rounds)
  │
  ▼
wave.json = [ { id, prompt, mode: read|write|shell|full, cwd, after, afterAny,
                schema, maxTurns, resumeSessionId, … } ]
  │
  ▼
grok-fan.ps1 — ≤10 parallel `grok` processes, honours `after`, enforces auto + model pin
  │            writer (mode full) ──after──► blind verifier (never sees writer's output)
  ▼
outdir/  _summary.json   status, numTurns, suspectNoToolCall, sessionId, costUSD — read FIRST
         <id>.json       structuredOutput = the only field you may parse
         <id>.err.txt    _prompts/<id>.txt
  │
  ▼
ORCHESTRATOR verifies: open the files, run the proof yourself.
numTurns==1 ⇒ fabricated ⇒ corrective round via resumeSessionId (max 2, then do it yourself)
```

## Measured behaviour (grok 1.0.4 / grok-4.6 — evidence in the repo README)

1. **`--permission-mode auto` is mandatory** for anything that writes or runs commands. Every other mode *cancels* the tool call silently (turn 1, exit 0, no stderr) while the task reports success. The runner refuses `write`/`shell`/`full` under any other mode.
2. **Fabrication is real; `numTurns == 1` is the tell.** Grok invents schema-valid answers rather than call a tool. `status: ok` and a populated `structuredOutput` carry no information; the runner flags this as `suspectNoToolCall`. Defence: ask for what cannot be guessed — exact line numbers, exact strings, real command output.
3. **Parse `structuredOutput` only.** `text` concatenates every turn, including tool calls pressed through the schema.
4. **max-turns = exit 1 + stderr `max turns reached`**, stopReason stays `cancelled`; the payload still parses → status `truncated`, cost counted.
5. **Unknown names in `--tools` are silently ignored** — a typo looks like model failure.
6. **Resume works headless**: `resumeSessionId` keeps the session's context, so a corrective round states only what is wrong.
7. **`xhigh` is the top of the effort ladder** — anything higher fails the run outright, no fallback.

## The worker is fixed: grok-4.6 at xhigh

Standing instruction, enforced twice: the runner's `-Model`/`-Effort` accept only these values, and per-task `model`/`effort` fields are **refused**. Never downgrade for "cheap mechanical" work.

## Hard rules

1. **Self-contained prompts.** Subagents share no history with you or each other: absolute paths, what to read first, the exact task, acceptance criteria, output contract. (Exception: `resumeSessionId` continues a real session.)
2. **`auto` or it did not happen** — runner-enforced.
3. **Writers must be disjoint.** Same-file writers must be sequenced with `after`.
4. **Schema for anything you parse**; read `structuredOutput`, never `text`.
5. **Ask for the unguessable**, then check `numTurns`.
6. **Never verify by asking Grok** — sole exception: a *blind* verifier that never saw the writer's claims. Run the proof command yourself regardless.
7. **No recursion** — `--no-subagents` is default; `allowSubagents: true` only for deliberately open-ended exploration.
8. **Never let a subagent block.** `ask_user_question` is denied; end every prompt with "if something is ambiguous, state it and pick the most conservative reading — you cannot ask questions."

## Protocol

Scope (goal + acceptance in 2–3 lines) → decompose (≤10 disjoint units; every implementation unit gets a proof command that **fails loudly on an empty diff**) → announce the wave (id, mode, one-line intent) → one runner call per wave (the runner parallelizes — never fan out at your own tool level) → triage `_summary.json` → verify substance yourself → integrate, report rejects and `totalCostUSD`.

For review-shaped jobs slice by **dimension** (correctness, performance, API contract, test coverage), not by file, each with a schema.

Statuses: `ok` (still check `suspectNoToolCall`/`numTurns`) · `truncated` (narrow the slice or raise `maxTurns`) · `skipped` (dependency not ok) · `unparsable` (treat as failed) · `failed`/`timeout` (read `<id>.err.txt`).

## Running a wave

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill dir>\grok-fan.ps1" `
  -TasksFile "<workdir>\wave1.json" -OutDir "<workdir>\wave1-out" `
  -DefaultCwd "D:\path\to\project" -MaxParallel 10
```

`-PermissionMode` (default `auto`; `dontAsk` only to harden a pure-read wave) · `-TimeoutSec` (default 1800/task) · `-DryRun` (print command lines, spend nothing). Exit 1 if any task not `ok` — read `_summary.json` regardless.

## Task file — a JSON array of task objects

| field | |
|---|---|
| `id`, `prompt` | required; `id` filename-safe and unique; `prompt` fully self-contained |
| `mode` | `read` (default) / `write` / `shell` / `full` — pick the narrowest that works |
| `cwd` | working dir; defaults to `-DefaultCwd` |
| `after`, `afterAny` | dependency id(s); `afterAny: true` runs even if the dependency failed (verifiers) |
| `maxTurns` | default 40 read / 80 otherwise |
| `schema` | JSON Schema → forces `structuredOutput` |
| `resumeSessionId`, `continueSession` | corrective rounds (sessionId from `_summary.json`) |
| `tools`, `rules`, `permissionMode`, `allowSubagents` | overrides; writing modes must stay `auto` |
| `model`, `effort` | **refused** — grok-4.6 at xhigh, always |

Tool profiles: `read` = `read_file,list_dir,grep` · `write` = + `write,search_replace` · `shell` = read + `run_terminal_command` · `full` = all. `write`/`shell`/`full` need `auto`.

### Writer + blind verifier — the core pattern

```json
[
  { "id": "fix",        "mode": "full",  "cwd": "D:\\repo", "prompt": "<frozen spec>" },
  { "id": "fix-verify", "mode": "shell", "cwd": "D:\\repo", "after": "fix", "afterAny": true,
    "prompt": "Inspect the working tree of D:\\repo and run: <proof command>. Judge only what you can observe. Report fail if the work is absent, incomplete, or the command does not pass.",
    "schema": { "type": "object", "required": ["verdict", "evidence"], "properties": {
      "verdict": { "type": "string", "enum": ["pass", "fail"] }, "evidence": { "type": "string" } } } }
]
```

The verifier prompt gets the acceptance criteria and the proof command — **never the writer's report**. The runner never injects a dependency's output into a dependent prompt, so blindness holds unless you paste it in yourself.

## Prompt template

```
CONTEXT      repo root; files in your slice (absolute paths); read these first
TASK         one precise instruction
ACCEPTANCE   how it is judged — include something unguessable
OUTPUT       exact shape, or "match the required JSON schema"
CONSTRAINTS  stay in your slice; do not run the full test suite; if something is
             ambiguous, state it and pick the most conservative reading — you
             cannot ask questions.
```

## Shape 3 — fanout pipeline (harness with a `Workflow` tool only)

```
Workflow({ scriptPath: '<skill dir>\\grok-fanout.js',
           args: { goal: '<what to build>', repo: '.', maxWorkers: 6, isolation: 'worktree' } })
```

args: `goal` (required) · `repo` ('.') · `maxWorkers` (6, cap 10) · `maxRounds` (2) · `isolation` (`worktree`; **`none` outside a git repo**) · `specReview` (true). No argument selects the orchestrator or the Grok model/effort — thinking agents inherit the calling session, Grok is pinned. `grok-fanout.js` needs `RUNNER_DEFAULT` (or `args.runner`) set to the runner's absolute path. Without a `Workflow` tool, run the equivalent by hand: freeze specs, dispatch writer + blind-verifier waves, review each diff yourself.

## Platform notes

- The runner invokes the packaged node entrypoint, never `grok.cmd`/`grok.ps1` — the npm shims destroy the embedded quotes in `--json-schema`. Do not "simplify" this.
- Never pipe grok through `2>&1` in PowerShell 5.1.
- `grok --worktree` does nothing in headless mode; isolation comes from Workflow worktrees or disjoint file partitioning.
- Grok Build reads the Claude `settings.json` for permissions and inherits its MCP servers.
- Copies of this skill (per-harness installs, repo) must stay in step; source of truth: github.com/sauerlandtreffi/grok-w.
- Cost is not the constraint (~$0.002–0.02 per small task; a 10-task wave lands well under $0.50) — still report `totalCostUSD` from `_summary.json`.
