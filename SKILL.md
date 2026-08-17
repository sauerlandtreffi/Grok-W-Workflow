---
name: grok-w
description: Grok-W — Grok Build CLI subagents do the labour (always grok-4.6 at xhigh, the top of its ladder; never any other model or effort), and whoever invoked the skill orchestrates and owns every judgement. Use this skill whenever the user's message contains "Grok-W", "grok-w", "GrokW" or "/grok-w", in any casing and anywhere in the message. Three shapes: a single call, a parallel wave of up to 10 Grok tasks via grok-fan.ps1, or the grok-fanout pipeline (plan → harden specs → Grok writer + blind Grok verifier per item → independent diff review).
---

# Grok-W — orchestrated Grok fan-out

**Trigger:** any message containing `Grok-W` (any casing). Typing it *is* the opt-in — do not ask "should I run the workflow?", just run the protocol below.

## Doctrine

Push as much work down to Grok as the task allows. Keep every judgement above it.

**The orchestrator is whoever invoked this skill** — this session, whatever model it happens to be running. There is no lane to pick, no second brain to bring in, and nothing here is model-specific. If you are reading this, you are the orchestrator.

| Orchestrator — you | Grok 4.6 subagents |
|---|---|
| Understand the goal, set acceptance criteria | Read and search code inside their slice |
| Decompose into disjoint items, freeze specs | Implement from a frozen spec |
| Write the proof command that settles each item | Run narrowly scoped commands and tests |
| Review the real diff against the real files | Draft analyses, audits, docs |
| Resolve conflicts, integrate, run the real build | Judge *their own* work — never |
| Decide when the job is done | — |

Grok is fast, parallel and cheap enough that cost is not the constraint — throughput is. So fan out wide, and spend your own intelligence on the two things that actually decide the outcome: **the spec going in** and **the diff coming out**.

**A Grok result is a proposal, never a fact.** Not a stylistic caution — see Measured behaviour.

## Measured behaviour — grok 1.0.4 / grok-4.6, verified on this machine

Everything here was reproduced against real files and real disk state, not inferred.

**1. `--permission-mode auto` is mandatory for any task that writes or runs commands.**
Under `dontAsk`, `default` or `acceptEdits`, grok *cancels* the tool call: the session ends at turn 1 with `stopReason: "cancelled"`, **exit code 0 and no stderr**. A write task then reports success while nothing reached the disk. Verified across writer and `search_replace` tasks, on new and existing files. `auto` is the only mode where `write`, `search_replace` and `run_terminal_command` execute. The runner defaults to `auto` and **refuses** `write`/`shell`/`full` tasks under any other mode.

**2. Grok fabricates results rather than call a tool, and `numTurns == 1` is the tell.**
Asked to report `node --version` with `run_terminal_command` available and an explicit "do not answer from prior knowledge", it returned schema-valid `v22.22.0` — the real answer was `v24.14.0` — without ever running the command. Asked to extract three facts from a file it had read access to, it invented all three. Two write tasks reported the exact path and content they had "written"; neither file existed.

Across 22 tasks the correlation was perfect: **`numTurns == 1` on a task that needed a tool call ⇒ the answer was fabricated; `numTurns ≥ 2` ⇒ the answer was correct.** `status: ok` carries no information, and neither does a populated `structuredOutput` — the fabricated answers were schema-valid and confident. The runner exposes this as `suspectNoToolCall`.

The practical defence, beyond checking `numTurns`: **ask for something Grok cannot know.** Demand exact line numbers, exact strings, a token from a file, the output of a command whose result is unguessable. A task that can only be answered by looking will be answered by looking — the same model that invented `node --version` read an opaque token out of a file correctly on the first try, because there was nothing to guess.

**3. `structuredOutput` is the only trustworthy field; `text` is unusable with a schema.**
`text` concatenates every turn, including tool invocations pressed through the schema. A real observed `text`: `{"model":"read_file","timeoutSec":"C:\\...\\grok-fan.ps1","modelLine":0}` — that is the *tool call* — immediately followed by the genuine answer `{"model":"grok-4.6","timeoutSec":"1800","modelLine":39}`. Without a schema, narration is glued to the answer with no separator: `"I'll read only SKILL.md and extract the titles.1. Self-contained prompts."`

**4. max-turns is exit 1 + stderr, never a `stopReason`.**
Hitting `--max-turns` exits 1 with stderr `Error: max turns reached` and reports `stopReason: "cancelled"`. There is no `max_turns` stop reason. The payload is still complete, including cost, so the runner parses it regardless of exit code.

**5. An unknown tool name in `--tools` is silently ignored.**
No error, anywhere — the subagent simply lacks that tool. A typo in a tool profile costs you the tool and looks like model failure.

**6. Resume works headless and keeps context.**
`--resume <sessionId>` (or `--continue` per cwd) with `--prompt-file` continues the same session: it recalled a file it had created without being told the path again and edited it correctly. This is what makes a corrective round cheap — state only what is wrong, not the whole task again.

## Three shapes

Pick the smallest that fits.

### 1 — Single call

One self-contained question or one self-contained edit. Use the runner with a one-task file anyway: you get `_summary.json`, `numTurns`, the suspect flag, cost and the `sessionId` for free, and the prompt is archived for re-runs.

### 2 — Swarm wave (`grok-fan.ps1`)

Up to 10 Grok tasks in parallel, dependency-ordered. The right shape for audits, reviews, research sweeps and bulk mechanical edits across disjoint files. You plan the wave, you verify every result. This is the workhorse.

For review-shaped jobs slice by **dimension** (correctness, performance, API contract, test coverage), not by file, and give every dimension a schema.

### 3 — Fanout pipeline (`grok-fanout.js`, needs a harness with a `Workflow` tool)

Plan → harden specs → per item (Grok writer + blind Grok verifier + proof) → independent diff review → integrate. Use it when the work is an *implementation* with more than a couple of items and a real proof command exists.

```
Workflow({ scriptPath: '<SKILL_DIR>/grok-fanout.js',
           args: { goal: '<what to build>', repo: '.', maxWorkers: 6,
                   isolation: 'worktree' } })
```

`args`: `goal` (required), `repo` (default `.`), `runner` (absolute path to `grok-fan.ps1`; omit only if you filled in `RUNNER_DEFAULT` at install time), `maxWorkers` (default 6, cap 10), `maxRounds` (default 2), `isolation` (`worktree` default, **`none` when the session cwd is not a git repo**), `specReview` (default true).

There is deliberately no argument for who orchestrates and none for the Grok model or effort. The planning, spec and review agents inherit the calling session; Grok is pinned. Nothing to tune, nothing to get wrong.

Two gates, both there because of what Grok measurably is:

- **The blind verifier.** A second Grok run, scheduled `after` the writer in the same wave, in the same worktree, that is never shown the writer's output — the runner does not feed a dependency's result into a dependent prompt. It judges disk state and the proof command only. A verifier that has seen the writer's claims is not a verifier.
- **The independent review.** A fresh agent gets the spec and the diff, and deliberately *not* the worker's self-report. An empty or near-empty diff is a reject regardless of what any report says.

## The Grok worker is fixed: grok-4.6 at xhigh

**Always `grok-4.6`, always `xhigh` reasoning effort. There is no worker lane to choose.** This is a standing instruction, not a default to be tuned per task — do not drop the effort for "cheap mechanical" work and do not reach for `grok-4.5`.

`xhigh` is the top of grok's ladder, confirmed by the CLI itself:

```
Error: --effort/--reasoning-effort: unknown effort level 'max'; use one of: xhigh, high, medium, low
```

Asking for a higher level fails the run outright — it does not silently fall back to `xhigh`.

Both layers enforce this rather than trusting discipline: `grok-fan.ps1` accepts only those two values for `-Model`/`-Effort` and **refuses** a task file containing per-task `model` or `effort` fields, and `grok-fanout.js` pins them as constants with no matching `args`. A silently downgraded worker is precisely the failure this skill exists to prevent, so the failure is loud instead.

## Hard rules

1. **Self-contained prompts.** Subagents share no history with you and none with each other. Every prompt carries absolute paths, what to read first, the exact task, the acceptance criteria and the exact output contract. Never write "as discussed", "the file above", or "continue from the previous step". The one exception is a `resumeSessionId` task, which continues a real session.
2. **`auto` or it did not happen.** Any task that writes or runs commands needs `permissionMode: auto`. The runner enforces this; do not work around it.
3. **Writers must be disjoint.** Two `write`/`full` tasks in the same wave must never touch the same file. If you cannot partition cleanly, sequence them with `after`.
4. **Schema for anything you parse**, and read `structuredOutput` — never `text`.
5. **Ask for what cannot be guessed.** Line numbers, exact strings, command output. Then check `numTurns`.
6. **Never verify by asking Grok** — with one structural exception: a *blind* verifier that has not seen the writer's claims and reports only observable state. Even then, run the proof command yourself.
7. **No recursion.** `--no-subagents` is the default; orchestration stays with you. Set `allowSubagents: true` only for a deliberately open-ended exploration task.
8. **Never let a subagent block.** `ask_user_question` is denied and prompts must end with "if something is ambiguous, state it and pick the most conservative reading — you cannot ask questions."

## Protocol

**1 — Scope.** Restate the goal and acceptance criteria in two or three lines. Explore only as much as you need to decompose (usually a Glob/Grep, not full reads).

**2 — Decompose.** At most 10 genuinely independent units per wave. Every unit gets its acceptance criteria; every implementation unit gets an exact proof command that **fails loudly when the work is wrong** — a proof that passes on an empty diff is worthless.

**3 — Announce.** Print the wave as a short list — id, mode, one-line intent — before running it.

**4 — Fan out.** Write the task file, run the runner once.

**5 — Triage `_summary.json` first.**

| status | meaning |
|---|---|
| `ok` | read the result file — then check `suspectNoToolCall` and `numTurns` before believing it |
| `truncated` | hit `--max-turns`; re-task with a narrower slice or a higher `maxTurns` |
| `skipped` | a dependency did not end `ok`; nothing ran |
| `unparsable` | exited 0 without valid JSON; treat as failed |
| `failed` / `timeout` | read the matching `<id>.err.txt` |

**6 — Verify the substance.** For every claim you intend to act on, open the file yourself. Run builds and tests yourself. Discard anything you cannot confirm. A `suspectNoToolCall` result is fabricated until proven otherwise.

**7 — Integrate.** Apply and merge, resolve conflicts, run the real build, then report — including what you rejected and why, and the wave's `totalCostUSD`.

Repeat waves until the acceptance criteria are met. After two failed corrective rounds on one item, stop delegating it and do it yourself.

## Running a wave

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>\grok-fan.ps1" `
  -TasksFile "<workdir>\wave1.json" `
  -OutDir    "<workdir>\wave1-out" `
  -DefaultCwd "<path\to\project>" `
  -MaxParallel 10
```

Parameters: `-PermissionMode` (default `auto`; `dontAsk` only to harden a wave of pure read tasks), `-TimeoutSec` (default 1800, per task), `-MaxParallel` (1–10), `-DryRun` (print the exact command lines without spending anything). `-Model` and `-Effort` exist but accept only `grok-4.6` and `xhigh` — passing them is redundant, passing anything else fails.

Exit code is 1 if any task did not end `ok` — but always read `_summary.json` rather than trusting the exit code alone.

## Task file contract

A JSON **array** of task objects.

| Field | Meaning |
|---|---|
| `id` | required, unique, filename-safe |
| `prompt` | required, fully self-contained |
| `cwd` | working dir; defaults to `-DefaultCwd` |
| `mode` | `read` (default) / `write` / `shell` / `full` |
| `after` | task id or array of ids that must finish first |
| `afterAny` | run even if a dependency did not end `ok` (use for a verifier that must inspect a failed writer's mess) |
| `maxTurns` | default 40 for `read`, 80 otherwise |
| `schema` | JSON Schema; forces structured output into `structuredOutput` |
| ~~`model` / `effort`~~ | **refused** — the runner throws if either appears. grok-4.6 at xhigh, always |
| `permissionMode` | per-task override; writing modes must be `auto` |
| `resumeSessionId` | continue that grok session (from a previous `_summary.json`) |
| `continueSession` | continue the most recent session for this `cwd` |
| `tools` | explicit comma-separated allowlist, overrides `mode` |
| `rules` | extra system-prompt rules for that subagent |
| `allowSubagents` | `true` lets Grok fan out further (off by default) |

**Tool profiles** (verified tool names, grok 1.0.4 — a typo here is silently ignored):

| mode | tools | needs `auto` |
|---|---|---|
| `read` | `read_file, list_dir, grep` | no |
| `write` | + `write, search_replace` | **yes** |
| `shell` | `read_file, list_dir, grep, run_terminal_command` | **yes** |
| `full` | everything above | **yes** |

Pick the narrowest mode that can do the job. `read` cannot damage anything and is the right default for audits, reviews and research.

### Writer + blind verifier in one wave

The pattern the fanout pipeline uses, and the one to reach for by hand whenever an item has a proof command:

```json
[
  { "id": "hud-fix",        "mode": "full",  "cwd": "D:\\repo", "prompt": "<frozen spec>" },
  { "id": "hud-fix-verify", "mode": "shell", "cwd": "D:\\repo", "after": "hud-fix", "afterAny": true,
    "prompt": "Inspect the working tree of D:\\repo and run: <proof command>. Judge only what you can observe. Report fail if the work is absent, incomplete, or the command does not pass.",
    "schema": { "type": "object", "required": ["verdict", "evidence"],
      "properties": { "verdict": { "type": "string", "enum": ["pass", "fail"] }, "evidence": { "type": "string" } } } }
]
```

The verifier prompt contains the acceptance criteria and the proof command — **never the writer's report**. The runner does not inject a dependency's output into a dependent prompt, so blindness holds unless you paste it in yourself.

## Result files

Per wave, in `-OutDir`:

- `_summary.json` — per task: `status`, `exitCode`, `seconds`, `stopReason`, `numTurns`, **`suspectNoToolCall`**, **`sessionId`**, `costUSD`, `after`; plus `totalCostUSD` and `suspect` counts. **Read this first.**
- `<id>.json` — the raw Grok result: `text`, `stopReason`, `usage`, `total_cost_usd`, and `structuredOutput` when a schema was given.
- `<id>.err.txt` — stderr, only when non-empty.
- `_prompts/<id>.txt` — the exact prompt that was sent, for debugging and re-runs.

## Prompt template

```
CONTEXT
  Repo root: D:\...
  Files in your slice: <absolute paths>
  Read these first: <the files that ground the task>
  Everything you need is in those files. Do not go outside your slice.

TASK
  <one precise instruction>

ACCEPTANCE
  <how the result will be judged — include something unguessable:
   exact line numbers, exact strings, real command output>

OUTPUT
  <exact shape; or "match the required JSON schema" when a schema is set>

CONSTRAINTS
  Do not modify files outside your slice.   # write modes
  Do not run the full test suite.           # the orchestrator does that
  If something is ambiguous, state the ambiguity in your output and pick the
  most conservative reading — you cannot ask questions.
```

The last line matters: `ask_user_question` is denied, so a subagent that wants to ask will otherwise stall or guess silently.

## Platform notes

- **Windows quoting.** The runner deliberately invokes the packaged node entrypoint (`%APPDATA%\npm\node_modules\@xai-official\grok\bin\grok`) rather than `grok.cmd`/`grok.ps1`. The npm shims re-parse arguments and destroy the embedded quotes in `--json-schema`. Do not "simplify" this back to `grok.cmd`.
- **stderr.** Never pipe grok through `2>&1` in PowerShell 5.1 — it wraps each stderr line in a `NativeCommandError` and corrupts `$?`. The runner captures both streams separately.
- **Worktrees.** `grok --worktree` does **not** create one in headless mode, so isolation comes from the harness's `Workflow` layer (`isolation: 'worktree'`) or from disjoint file partitioning. Worktrees share the git object store, so a reviewer in the main repo can read a worker branch's diff.
- **No shell in Workflow scripts.** A `Workflow` script can only call `agent()`; it cannot run PowerShell. That is why the writer/verifier ordering lives in the runner's `after` field rather than in the workflow script, and why a Grok worker is always reached through the runner. It is also why `grok-fanout.js` cannot discover its own location and needs the runner path configured.
- **Inherited config.** Grok Build reads your agent harness's permission settings and inherits its configured MCP servers, so a subagent can reach the same MCP tools you can when a task genuinely needs one. Keep that in mind when choosing a tool profile.
- **Installing to more than one harness.** Copy the whole skill directory into each harness's skills directory; the runner is harness-agnostic. Shapes 1 and 2 work anywhere PowerShell does; shape 3 needs a `Workflow` tool. Keep the copies in step.

## Cost

Cost is not the constraint here — throughput and correctness are. `grok-4.6` at `xhigh` ran roughly $0.002–0.02 per small task in testing; a 10-task wave lands well under $0.50, and the whole verification apparatus described in this document was built and validated for about $0.15. Report the actual spend from `_summary.json` → `totalCostUSD` anyway, so the user can see what a wave costs.
