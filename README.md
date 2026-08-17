# Grok-W

An agent skill for delegating bulk work to [Grok Build CLI](https://www.npmjs.com/package/@xai-official/grok) subagents — up to 10 in parallel, dependency-ordered — while the orchestrating agent keeps every judgement.

It is built around one measured fact: **Grok will report success for work it never performed.** Not occasionally, and not in a way that looks like failure. So this is not a thin fan-out wrapper. The verification is the product.

## You are an agent and were just handed this link

Then you are meant to be the **orchestrator**. Do this, in order:

1. **Check the prerequisites**: Node ≥ 18 and the Grok Build CLI — `npm i -g @xai-official/grok`, then `grok login` (once, interactive). Works the same on Linux, macOS and Windows.
2. **Get the files**: `git clone https://github.com/sauerlandtreffi/grok-w` — or copy the directory into your harness's skills folder (e.g. `~/.claude/skills/grok-w/`) to install it as a skill.
3. **Read `SKILL.md` in full.** It is the operating doctrine — the map, the hard rules, the task-file contract, the verification protocol. This README is background and evidence.
4. **Dispatch a wave**: write a JSON task file (start from `examples/`), then run
   `node grok-fan.mjs --tasks-file wave.json --out-dir wave-out --default-cwd /path/to/project`.
5. **Verify before you believe**: read `wave-out/_summary.json` first; a task with `suspectNoToolCall: true` (or `numTurns: 1` where a tool call was needed) is fabricated until you prove otherwise, and every claim you act on must be checked against the real files by you.

The model and effort are pinned — `grok-4.6` at `xhigh`, enforced by the runner. There is nothing to configure and nothing to choose.

## Why the verification matters

While testing a naive fan-out, 22 tasks were run against real files and real disk state. What came back:

- Asked to report `node --version` with `run_terminal_command` available and an explicit *"do not answer from prior knowledge"*, Grok returned a schema-valid `v22.22.0`. The real answer was `v24.14.0`. It never ran the command.
- Two write tasks reported the exact path and content they had "written", with `stopReason: "end_turn"` and `status: ok`. Neither file existed.
- Asked to extract three facts from a file it had read access to, it invented all three.

The tell turned out to be mechanical and, across all 22 tasks, perfectly correlated:

> **`numTurns == 1` on a task that needed a tool call ⇒ the answer was fabricated.
> `numTurns >= 2` ⇒ the answer was correct.**

`status: ok` carries no information. Neither does a populated `structuredOutput` — the fabricated answers were schema-valid and confident. The runner surfaces this as `suspectNoToolCall` and the doctrine treats a flagged result as fabricated until proven otherwise.

The other practical defence is prompt design: **ask for something the model cannot know.** Exact line numbers, exact strings, a token from a file, the output of a command whose result is unguessable. The same model that invented `node --version` read an opaque token out of a file correctly on the first try — because there was nothing to guess.

## The other measured findings

Each of these was reproduced against real state, and each one silently breaks a naive integration:

| | |
|---|---|
| **`--permission-mode auto` is mandatory** for any task that writes or runs commands. Under `dontAsk`, `default` or `acceptEdits`, Grok **cancels** the tool call: session ends at turn 1 with `stopReason: "cancelled"`, **exit code 0 and no stderr**. A write task reports success while nothing reaches the disk. | The runner defaults to `auto` and **refuses** `write`/`shell`/`full` tasks under any other mode, rather than letting them no-op. |
| **`text` is unusable with a schema.** It concatenates every turn, including tool invocations pressed through the schema. One real `text` began `{"model":"read_file","timeoutSec":"…/grok-fan.ps1"}` — that is the *tool call* — followed by the genuine answer. | Read `structuredOutput`, never `text`. |
| **max-turns is exit 1 + stderr, never a `stopReason`.** Hitting `--max-turns` exits 1 with stderr `Error: max turns reached` and reports `stopReason: "cancelled"`. There is no `max_turns` stop reason. | The runner detects the stderr marker and still parses the payload, so a truncated task is reported as `truncated` and its cost is counted. |
| **An unknown tool name in `--tools` is silently ignored.** No error anywhere; the subagent simply lacks that tool. | A typo in a tool profile looks exactly like model failure. The profiles here are verified against the shipped binary. |
| **`xhigh` is the top of the reasoning ladder.** `max` and `ultra` are rejected: `unknown effort level 'max'; use one of: xhigh, high, medium, low`. | Asking for more fails the run outright; it does not fall back. |
| **Resume works headless and keeps context.** `--resume <sessionId>` with `--prompt-file` continues the session — it recalled a file it had created without being told the path again. | Corrective rounds state only what is wrong, not the whole task again. |

Verified against `grok 1.0.4` / `grok-4.6` on Windows.

## What is in here

| File | |
|---|---|
| `SKILL.md` | The doctrine an agent reads: what to delegate, how to write a prompt a zero-context model cannot misread, how to verify, and the full task-file contract. |
| `grok-fan.mjs` | **The dispatch runner** — plain Node, runs everywhere the Grok CLI does (Linux, macOS, Windows). Runs a JSON array of tasks in parallel with a concurrency throttle, honours `after` dependencies, and writes a machine-readable `_summary.json`. |
| `grok-fan.ps1` | The original Windows-native runner (PowerShell 5.1+). Same task contract, same summary, same enforcement — kept as a fallback for machines where Node scripts are unwelcome. |
| `grok-fanout.js` | An optional pipeline for implementation work: plan → harden specs → per item (Grok writer + blind Grok verifier + proof command) → independent diff review → integrate. Needs a harness with a `Workflow` tool. |
| `examples/` | Two working task files: a schema-driven audit wave, and the writer + blind-verifier pattern. |

### Three shapes

**Single call** — one self-contained question or edit. Still worth going through the runner: you get `numTurns`, the suspect flag, cost and the `sessionId` for free, and the prompt is archived for re-runs.

**Swarm wave** — up to 10 tasks in parallel. The workhorse: audits, reviews, research sweeps, bulk mechanical edits across disjoint files. For review-shaped jobs, slice by *dimension* (correctness, performance, API contract, test coverage) rather than by file, and give every dimension a schema.

**Fanout pipeline** — for implementation work with a real proof command. Two gates a naive pipeline does not have:

- **A structurally blind verifier.** A second Grok run, scheduled `after` the writer in the same wave, that is never shown the writer's output — the runner does not feed a dependency's result into a dependent prompt. It judges disk state and the proof command only. *A verifier that has seen the writer's claims is not a verifier.*
- **An independent diff review.** A fresh agent gets the spec and the diff, and deliberately *not* the worker's self-report. An empty or near-empty diff is a reject regardless of what any report says.

## Map — how the tasks are put together

```
ORCHESTRATOR (the invoking agent) · scope → decompose → freeze specs → dispatch → verify → integrate
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
outdir/  _summary.json   status, numTurns, suspectNoToolCall, sessionId, costUSD — read FIRST
         <id>.json       structuredOutput = the only field to parse
         <id>.err.txt    _prompts/<id>.txt
  │
  ▼
ORCHESTRATOR verifies: open the files, run the proof command itself.
numTurns==1 ⇒ fabricated ⇒ corrective round via resumeSessionId (max 2, then stop delegating)
```

### The same map, agents only — who runs on which side

```
┌─ INVOKER SIDE — your model · every judgement ──────────────────────────────
│
│   ORCHESTRATOR = the invoking session (Claude, Codex, …)
│     owns goal + acceptance criteria · verifies everything · merges at the end
│
│   Shape 3 only adds subagents — all of them STILL your model:
│     PLANNER               decomposes the goal into frozen, disjoint specs
│     SPEC REVIEWER         hunts ambiguity before anything is dispatched
│     WORKER ×1 per item    dispatches Grok · runs the proof · judges · resumes
│     INDEPENDENT REVIEWER  sees spec + real diff — never anyone's self-report
│
│   (Shapes 1+2: no subagents — the orchestrator does all of this itself)
│
└───────────────────────────┬────────────────────────────────────────────────
                            │   the ONLY crossing point:
                            │   wave.json ▼ · results ▲   (grok-fan.mjs, model pinned)
┌───────────────────────────┴─ GROK SIDE — grok-4.6 @ xhigh ─────────────────
│
│     GROK WRITER / WORKER ×≤10   reads · implements the spec · scoped commands
│     GROK BLIND VERIFIER         sees only disk state + the proof command
│
│     labour only — nothing down here plans, judges, or verifies its own work
│
└────────────────────────────────────────────────────────────────────────────
```

Everything above the line thinks at the invoker's level; everything below it only
types and executes. The blindness rules hold on both sides: the verifier never sees
the writer's claims, the reviewer never sees the worker's report.

## Install

Requires Node ≥ 18 and the Grok Build CLI: `npm i -g @xai-official/grok`, then `grok login` (once, interactive).

Copy this directory into your agent harness's skills directory, e.g.:

```
~/.claude/skills/grok-w/
```

Then, if you want the fanout pipeline, open `grok-fanout.js` and fill in `RUNNER_DEFAULT` with the absolute path to `grok-fan.mjs` — a `Workflow` script has no filesystem access and cannot discover its own location. You can also pass `args.runner` per invocation instead.

The skill triggers on the word `Grok-W` in any message, in any casing.

### Windows

Nothing changes: `node grok-fan.mjs …` works identically from PowerShell or cmd. The runner spawns the packaged `bin/grok` directly with an argument array and no shell, which sidesteps the two classic Windows traps (the npm shims `grok.cmd`/`grok.ps1` destroy the embedded quotes in `--json-schema`, and piping grok through `2>&1` in PowerShell 5.1 corrupts `$?`). If Node scripts are unwelcome on a machine, `grok-fan.ps1` is the original Windows-native runner with the same contract: `-TasksFile` `-OutDir` `-DefaultCwd` `-MaxParallel` `-PermissionMode` `-TimeoutSec` `-DryRun`.

## Running a wave

```bash
node grok-fan.mjs \
  --tasks-file examples/audit-wave.json \
  --out-dir wave-out \
  --default-cwd /path/to/project \
  --max-parallel 10
```

Read `_summary.json` first. Per task it gives `status`, `numTurns`, `suspectNoToolCall`, `sessionId`, `costUSD` and `stopReason`; plus `totalCostUSD` and a `suspect` count for the wave. `--dry-run` prints the exact command lines without spending anything; env `GROK_ENTRY` overrides the grok-binary auto-detection.

A minimal task file:

```json
[
  {
    "id": "null-check-audit",
    "mode": "read",
    "cwd": "/path/to/project",
    "prompt": "Read src/combat/*.ts. Find every place damage is applied without a null check on the target. Report the file, the 1-based line number, and the exact expression, copied character-for-character.",
    "schema": {
      "type": "object",
      "required": ["findings"],
      "properties": {
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["file", "line", "expression"],
            "properties": {
              "file": { "type": "string" },
              "line": { "type": "integer" },
              "expression": { "type": "string" }
            }
          }
        }
      }
    }
  }
]
```

Note what that prompt asks for: line numbers and character-exact expressions. Both are unguessable, so the task can only be answered by actually reading. That is the point.

See `SKILL.md` for the full field reference, the tool profiles, and the writer + blind-verifier pattern.

## Status

The measured findings and the original verification battery were established with `grok-fan.ps1` on Windows: every status path, the dependency scheduler, the `auto` enforcement, cost accounting on non-zero exits, resume, and the writer + blind-verifier pattern end-to-end — including the negative case, where a deliberately truncated writer produced no file and the blind verifier returned `fail` with the real `MODULE_NOT_FOUND` output as its evidence.

`grok-fan.mjs` is a faithful port of that runner (same contract, same statuses, same summary) and was verified live on 2026-08-17: entrypoint auto-detection, `--dry-run` command construction, the `--json-schema` path end-to-end with character-exact results, the dependency scheduler including `skipped` and `afterAny`, BOM-tolerant task files, all three refusal paths (per-task `model`, per-task `effort`, writing mode without `auto`), and exit codes. Its POSIX-specific paths (symlink resolution of the `grok` shim, process-group kill on timeout) follow standard Node behaviour but have not yet been exercised on Linux hardware.

Re-validated live on 2026-08-17: on the very first probe task, Grok pressed its own narration into the schema at turn 1 without reading the target file — the runner flagged it `suspectNoToolCall`, and a corrective round via `resumeSessionId` then returned the character-exact answer at turn 2. The fabrication tell is not a hypothetical.

`grok-fanout.js` parses cleanly and is built entirely from that verified mechanism, but the pipeline has not yet been run end-to-end. Treat it as unproven.

## License

MIT — see `LICENSE`.
