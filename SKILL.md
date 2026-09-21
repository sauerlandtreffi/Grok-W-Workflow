---
name: grok-w
description: Grok Build CLI subagents do the labour (using the installed CLI's default model and reasoning effort); the invoking agent orchestrates and owns every judgement. Use whenever the user's message contains "Grok-W", "grok-w", "GrokW" or "/grok-w", any casing, anywhere. Shapes: single call, wave of up to 10 tasks via grok-fan.mjs, or the grok-fanout pipeline (Workflow tool).
---

# Grok-W — orchestrated Grok fan-out

**Landed here via the GitHub link?** Then you are meant to be the orchestrator, and this file is your operating manual. Prerequisites: Node ≥ 18 and the Grok Build CLI (`npm i -g @xai-official/grok`, then `grok login` once, interactively). Everything runs through one command — `node grok-fan.mjs` from this directory — identically on Linux, macOS and Windows. Read the Map and the Hard rules, write a task file (working examples in `examples/`), dispatch, verify. Nothing else is required.

**Trigger:** any message containing `Grok-W` (any casing). Typing it *is* the opt-in — run the protocol, don't ask.

**Orchestrator:** whoever invoked this skill — you. You scope, decompose, freeze specs, verify and integrate. Grok subagents read, implement from frozen specs, and run narrowly scoped commands — they never judge their own work. **A Grok result is a proposal, never a fact.** Fan out wide; spend your own intelligence on the spec going in and the diff coming out.

Files in this directory (`<skill dir>`): `grok-fan.mjs` — the runner, all platforms · `grok-fanout.js` — Workflow pipeline · `grok-fan.ps1` — legacy Windows-native runner (see the Windows section).

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
grok-fan.mjs — ≤10 parallel `grok` processes, honours `after`, enforces auto + model pin
  │            writer (mode full) ──after──► blind verifier (never sees writer's output)
  ▼
outdir/  _summary.json   status, numTurns, suspectNoToolCall, sessionId — read FIRST
         <id>.json       structuredOutput = the only field you may parse
         <id>.err.txt    _prompts/<id>.txt
  │
  ▼
ORCHESTRATOR verifies: open the files, run the proof yourself.
numTurns==1 ⇒ fabricated ⇒ corrective round via resumeSessionId (max 2, then do it yourself)
```

## Measured behaviour (Grok Build CLI 1.0.4 — evidence in the repo README)

1. **`--permission-mode auto` is mandatory** for anything that writes or runs commands. Every other mode *cancels* the tool call silently (turn 1, exit 0, no stderr) while the task reports success. The runner refuses `write`/`shell`/`full` under any other mode.
2. **Fabrication is real; `numTurns == 1` is the tell.** Grok invents schema-valid answers rather than call a tool. `status: ok` and a populated `structuredOutput` carry no information; the runner flags this as `suspectNoToolCall`. Defence: ask for what cannot be guessed — exact line numbers, exact strings, real command output.
3. **Parse `structuredOutput` only.** `text` concatenates every turn, including tool calls pressed through the schema.
4. **max-turns = exit 1 + stderr `max turns reached`**, stopReason stays `cancelled`; the payload still parses → status `truncated`.
5. **Unknown names in `--tools` are silently ignored** — a typo looks like model failure.
6. **Resume works headless**: `resumeSessionId` keeps the session's context, so a corrective round states only what is wrong.
7. **`xhigh` is the top of the effort ladder** — anything higher fails the run outright, no fallback.

## Select your model in Grok Build before running Grok-W

**Before starting a Grok-W wave, select the model and reasoning effort you want in Grok Build.** Grok-W intentionally omits `--model` and `--reasoning-effort`, so the installed Grok Build CLI uses its current configured defaults. Per-task `model`/`effort` fields are **refused**, keeping every task in a wave consistent. If a future CLI no longer supports defaults, use `grok-4.7` with `xhigh` as the explicit fallback.

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

Scope (goal + acceptance in 2–3 lines) → decompose (≤10 disjoint units; every implementation unit gets a proof command that **fails loudly on an empty diff**) → announce the wave (id, mode, one-line intent) → one runner call per wave (the runner parallelizes — never fan out at your own tool level) → triage `_summary.json` → verify substance yourself → integrate and report what you rejected and why.

For review-shaped jobs slice by **dimension** (correctness, performance, API contract, test coverage), not by file, each with a schema.

Statuses: `ok` (still check `suspectNoToolCall`/`numTurns`) · `truncated` (narrow the slice or raise `maxTurns`) · `skipped` (dependency not ok) · `unparsable` (treat as failed) · `failed`/`timeout` (read `<id>.err.txt`).

## Running a wave

```bash
node <skill dir>/grok-fan.mjs \
  --tasks-file wave1.json --out-dir wave1-out \
  --default-cwd /path/to/project --max-parallel 10
```

Options: `--permission-mode` (default `auto`; `dontAsk` only to harden a pure-read wave) · `--timeout-sec` (default 1800 per task) · `--dry-run` (print the exact command lines, spend nothing) · env `GROK_ENTRY` overrides the grok-binary auto-detection. The runner intentionally has no model or effort option: select them in Grok Build before you start the wave. Exit 1 if any task did not end `ok` — read `_summary.json` regardless.

## Task file — a JSON array of task objects

| field | |
|---|---|
| `id`, `prompt` | required; `id` filename-safe and unique; `prompt` fully self-contained |
| `mode` | `read` (default) / `write` / `shell` / `full` — pick the narrowest that works |
| `cwd` | working dir; defaults to `--default-cwd` |
| `after`, `afterAny` | dependency id(s); `afterAny: true` runs even if the dependency failed (verifiers) |
| `maxTurns` | default 40 read / 80 otherwise |
| `schema` | JSON Schema → forces `structuredOutput` |
| `resumeSessionId`, `continueSession` | corrective rounds (sessionId from `_summary.json`) |
| `tools`, `rules`, `permissionMode`, `allowSubagents` | overrides; writing modes must stay `auto` |
| `model`, `effort` | **refused** — select the Grok Build defaults before starting the wave |

Tool profiles: `read` = `read_file,list_dir,grep` · `write` = + `write,search_replace` · `shell` = read + `run_terminal_command` · `full` = all. `write`/`shell`/`full` need `auto`.

### Writer + blind verifier — the core pattern

```json
[
  { "id": "fix",        "mode": "full",  "cwd": "/repo", "prompt": "<frozen spec>" },
  { "id": "fix-verify", "mode": "shell", "cwd": "/repo", "after": "fix", "afterAny": true,
    "prompt": "Inspect the working tree of /repo and run: <proof command>. Judge only what you can observe. Report fail if the work is absent, incomplete, or the command does not pass.",
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
Workflow({ scriptPath: '<skill dir>/grok-fanout.js',
           args: { goal: '<what to build>', repo: '.', maxWorkers: 6, isolation: 'worktree' } })
```

args: `goal` (required) · `repo` ('.') · `maxWorkers` (6, cap 10) · `maxRounds` (2) · `isolation` (`worktree`; **`none` outside a git repo**) · `specReview` (true). No argument selects the orchestrator or Grok model/effort — thinking agents inherit the calling session and Grok uses the defaults you selected in Grok Build before starting the wave. `grok-fanout.js` needs `RUNNER_DEFAULT` (or `args.runner`) set to the absolute path of `grok-fan.mjs`. Without a `Workflow` tool, run the equivalent by hand: freeze specs, dispatch writer + blind-verifier waves, review each diff yourself.

## Windows

- `grok-fan.mjs` runs unchanged: `node <skill dir>\grok-fan.mjs --tasks-file wave1.json --out-dir wave1-out --default-cwd D:\path\to\project`. Same flags, same outputs; from PowerShell put it on one line or continue with a backtick.
- The runner is immune to the two classic Windows traps by construction — it spawns the packaged `bin/grok` directly with an argument array and no shell. If you ever call grok yourself, know them: the npm shims `grok.cmd`/`grok.ps1` re-parse arguments and destroy the embedded quotes in `--json-schema`; and piping grok through `2>&1` in Windows PowerShell 5.1 wraps stderr in `NativeCommandError` and corrupts `$?`.
- `grok-fan.ps1` is the original Windows-native runner (PowerShell 5.1+), kept as a fallback for machines where Node scripts are unwelcome: same task contract, same `_summary.json`, same enforcement. Parameters: `-TasksFile` `-OutDir` `-DefaultCwd` `-MaxParallel` `-PermissionMode` `-TimeoutSec` `-DryRun`.

## Platform notes

- `grok --worktree` does nothing in headless mode; isolation comes from Workflow worktrees or disjoint file partitioning.
- Grok Build reads the Claude `settings.json` for permissions and inherits its MCP servers.
- Copies of this skill (per-harness installs, repo) must stay in step; source of truth: github.com/sauerlandtreffi/grok-w.
