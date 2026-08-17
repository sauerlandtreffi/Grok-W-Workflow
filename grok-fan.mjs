#!/usr/bin/env node
// ============================================================================
// grok-fan.mjs — Grok-W dispatch runner. Cross-platform: Linux, macOS, Windows.
// Runs a dependency-ordered JSON array of Grok Build CLI tasks in parallel and
// writes one result file per task plus _summary.json. Doctrine, task-file
// contract and the measured Grok behaviour behind the defaults: see SKILL.md.
// Model and effort are pinned (grok-4.6 at xhigh); per-task overrides are
// refused, and writing modes are refused unless the permission mode is 'auto'.
//
// Usage:
//   node grok-fan.mjs --tasks-file wave.json --out-dir wave-out \
//        [--default-cwd DIR] [--max-parallel 10] [--permission-mode auto] \
//        [--timeout-sec 1800] [--dry-run]
// Env GROK_ENTRY overrides the grok-binary auto-detection.
// ============================================================================
import { spawn, execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const WIN = process.platform === 'win32'

// ---- CLI ------------------------------------------------------------------
const opts = {
  tasksFile: null, outDir: null, defaultCwd: process.cwd(),
  maxParallel: 10, model: 'grok-4.6', effort: 'xhigh',
  permissionMode: 'auto', timeoutSec: 1800, dryRun: false,
}
{
  const argv = process.argv.slice(2)
  const take = (i) => { if (i + 1 >= argv.length) fail(`missing value for ${argv[i]}`); return argv[i + 1] }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--tasks-file': opts.tasksFile = take(i); i++; break
      case '--out-dir': opts.outDir = take(i); i++; break
      case '--default-cwd': opts.defaultCwd = take(i); i++; break
      case '--max-parallel': opts.maxParallel = parseInt(take(i), 10); i++; break
      case '--model': opts.model = take(i); i++; break
      case '--effort': opts.effort = take(i); i++; break
      case '--permission-mode': opts.permissionMode = take(i); i++; break
      case '--timeout-sec': opts.timeoutSec = parseInt(take(i), 10); i++; break
      case '--dry-run': opts.dryRun = true; break
      default: fail(`unknown option: ${argv[i]}`)
    }
  }
}
function fail(msg) { console.error(`grok-fan: ${msg}`); process.exit(2) }

// Pinned by standing instruction: grok-4.6 at xhigh, never anything else.
// Accepting only these values makes a wrong call a loud failure, not a downgrade.
if (opts.model !== 'grok-4.6') fail(`--model accepts only 'grok-4.6' (got '${opts.model}'). Grok-W runs grok-4.6 exclusively.`)
if (opts.effort !== 'xhigh') fail(`--effort accepts only 'xhigh' (got '${opts.effort}'). xhigh is the top of grok's ladder.`)
if (!['auto', 'dontAsk', 'default', 'acceptEdits'].includes(opts.permissionMode)) {
  fail(`--permission-mode must be auto|dontAsk|default|acceptEdits (got '${opts.permissionMode}').`)
}
if (!opts.tasksFile) fail('--tasks-file is required.')
if (!(opts.maxParallel >= 1 && opts.maxParallel <= 10)) fail('--max-parallel must be 1..10.')

// ---- locate the grok entrypoint -------------------------------------------
// Always spawned as `node <entry> ...` with an args array (no shell), so the
// npm shim re-quoting problem that breaks --json-schema cannot occur.
function resolveGrokEntry() {
  const rel = path.join('@xai-official', 'grok', 'bin', 'grok')
  const candidates = []
  if (process.env.GROK_ENTRY) candidates.push(process.env.GROK_ENTRY)
  if (WIN) {
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'npm', 'node_modules', rel))
    }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    if (!WIN) {
      const shim = path.join(dir, 'grok')
      if (existsSync(shim)) {
        try { candidates.push(realpathSync(shim)) } catch { /* dangling link */ }
        candidates.push(path.join(dir, '..', 'lib', 'node_modules', rel))
      }
    } else if (existsSync(path.join(dir, 'grok.cmd'))) {
      candidates.push(path.join(dir, 'node_modules', rel))
    }
  }
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    candidates.push(path.join(prefix, 'lib', 'node_modules', rel), path.join(prefix, 'node_modules', rel))
  } catch { /* npm not on PATH — the other candidates must do */ }
  for (const c of candidates) {
    if (c && existsSync(c) && c.includes(path.join('@xai-official', 'grok'))) return c
  }
  fail("could not locate the Grok Build entrypoint. Is '@xai-official/grok' installed globally? (npm i -g @xai-official/grok, or set GROK_ENTRY)")
}
const grokEntry = resolveGrokEntry()

// ---- tool profiles --------------------------------------------------------
// Verified tool names (grok 1.0.4). grok silently IGNORES an unknown name in
// --tools, so a typo here costs the subagent that tool with no error anywhere.
const TOOL_PROFILES = {
  read: 'read_file,list_dir,grep',
  write: 'read_file,list_dir,grep,write,search_replace',
  shell: 'read_file,list_dir,grep,run_terminal_command',
  full: 'read_file,list_dir,grep,write,search_replace,run_terminal_command',
}
const WRITING_MODES = ['write', 'shell', 'full']

// ---- load and validate tasks ----------------------------------------------
if (!existsSync(opts.tasksFile)) fail(`tasks file not found: ${opts.tasksFile}`)
let tasks
// Strip a UTF-8 BOM: task files written by Windows tools routinely carry one.
try { tasks = JSON.parse(readFileSync(opts.tasksFile, 'utf8').replace(/^﻿/, '')) } catch (e) { fail(`tasks file is not valid JSON: ${e.message}`) }
if (!Array.isArray(tasks)) tasks = [tasks]
if (tasks.length === 0) fail(`tasks file contains no tasks: ${opts.tasksFile}`)

const seen = new Set()
for (const t of tasks) {
  if (typeof t.id !== 'string' || !t.id.trim()) fail("every task needs a string 'id'. The tasks file must be a JSON array of task objects.")
  if (typeof t.prompt !== 'string' || !t.prompt.trim()) fail(`task '${t.id}' has no string 'prompt'.`)
  if (/[\\/:*?"<>|]/.test(t.id)) fail(`task id '${t.id}' contains characters that are illegal in filenames.`)
  if (seen.has(t.id)) fail(`duplicate task id: ${t.id}`)
  // Refuse instead of ignore: a silently dropped override is exactly the class
  // of failure this runner exists to prevent.
  if (t.model != null) fail(`task '${t.id}': per-task 'model' is not allowed. Grok-W runs grok-4.6 exclusively; remove the field.`)
  if (t.effort != null) fail(`task '${t.id}': per-task 'effort' is not allowed. Grok-W runs at xhigh exclusively (the top of grok's ladder); remove the field.`)
  seen.add(t.id)
}

const afterOf = (t) => (t.after == null ? [] : (Array.isArray(t.after) ? t.after : [t.after])).filter(Boolean).map(String)
for (const t of tasks) {
  for (const d of afterOf(t)) {
    if (!seen.has(d)) fail(`task '${t.id}': 'after' names unknown task '${d}'.`)
    if (d === t.id) fail(`task '${t.id}': 'after' cannot reference itself.`)
  }
}
// Kahn's algorithm — a cycle would deadlock the scheduler, so reject it up front.
{
  const indeg = new Map(tasks.map(t => [t.id, afterOf(t).length]))
  const queue = tasks.filter(t => indeg.get(t.id) === 0).map(t => t.id)
  let sorted = 0
  while (queue.length) {
    const k = queue.shift(); sorted++
    for (const t of tasks) {
      if (afterOf(t).includes(k) && indeg.set(t.id, indeg.get(t.id) - 1).get(t.id) === 0) queue.push(t.id)
    }
  }
  if (sorted !== tasks.length) fail("the 'after' fields form a cycle. Fix the task file.")
}

if (!opts.outDir) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  opts.outDir = path.join(WIN ? (process.env.TEMP || '.') : '/tmp', 'grok-w', stamp)
}
mkdirSync(opts.outDir, { recursive: true })
const promptDir = path.join(opts.outDir, '_prompts')
mkdirSync(promptDir, { recursive: true })

// ---- build invocations ----------------------------------------------------
const plan = []
for (const t of tasks) {
  const mode = t.mode ? String(t.mode) : 'read'
  if (!(mode in TOOL_PROFILES)) fail(`task '${t.id}': unknown mode '${mode}' (use read|write|shell|full).`)
  const cwd = t.cwd ? String(t.cwd) : opts.defaultCwd
  if (!existsSync(cwd)) fail(`task '${t.id}': cwd does not exist: ${cwd}`)
  const maxTurns = t.maxTurns ? parseInt(t.maxTurns, 10) : (mode === 'read' ? 40 : 80)
  const permMode = t.permissionMode ? String(t.permissionMode) : opts.permissionMode

  // Fail loudly instead of dispatching a task that reports success and changes nothing.
  if (WRITING_MODES.includes(mode) && permMode !== 'auto') {
    fail(`task '${t.id}': mode '${mode}' needs permissionMode 'auto' (got '${permMode}'). ` +
      `Any other mode cancels write/search_replace/run_terminal_command silently — the task would ` +
      `report success with nothing written. Set permissionMode 'auto' on the task, or run the wave ` +
      `with --permission-mode auto.`)
  }

  const promptPath = path.join(promptDir, `${t.id}.txt`)
  writeFileSync(promptPath, String(t.prompt), 'utf8')

  const args = []
  // Resume must precede the prompt so the session is selected before the turn runs.
  if (t.resumeSessionId) args.push('--resume', String(t.resumeSessionId))
  else if (t.continueSession) args.push('--continue')
  args.push('--prompt-file', promptPath)
  args.push('--cwd', cwd)
  args.push('--model', opts.model)
  args.push('--reasoning-effort', opts.effort)
  args.push('--tools', t.tools ? String(t.tools) : TOOL_PROFILES[mode])
  args.push('--max-turns', String(maxTurns))
  // Headless hygiene: never block on a prompt, never re-plan, never recurse.
  args.push('--permission-mode', permMode)
  args.push('--deny', 'ask_user_question')
  args.push('--no-plan', '--no-memory')
  if (!t.allowSubagents) args.push('--no-subagents')
  if (t.rules) args.push('--rules', String(t.rules))
  if (t.schema) args.push('--json-schema', JSON.stringify(t.schema))
  else args.push('--output-format', 'json')

  plan.push({
    id: t.id, mode, cwd, permMode, after: afterOf(t), afterAny: !!t.afterAny, args,
    outFile: path.join(opts.outDir, `${t.id}.json`),
    errFile: path.join(opts.outDir, `${t.id}.err.txt`),
  })
}

if (opts.dryRun) {
  for (const p of plan) {
    const dep = p.after.length ? ` after=${p.after.join(',')}` : ''
    const disp = p.args.map(a => /[\s"']/.test(a) ? `'${a.replace(/'/g, WIN ? "'" : "'\\''")}'` : a).join(' ')
    console.log(`[${p.id}]${dep} ${process.execPath} ${grokEntry} ${disp}`)
  }
  process.exit(0)
}

// ---- run with a concurrency throttle, honouring dependencies --------------
console.log(`grok-w: ${plan.length} task(s), max ${opts.maxParallel} parallel, model=${opts.model} effort=${opts.effort} perm=${opts.permissionMode}`)
console.log(`grok-w: results -> ${opts.outDir}`)

const results = {}
const startedAt = Date.now()

function killTree(proc) {
  try {
    if (WIN) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-proc.pid, 'SIGKILL') // detached => own process group
  } catch { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
}

function runTask(item) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const proc = spawn(process.execPath, [grokEntry, ...item.args], {
      cwd: item.cwd, stdio: ['ignore', 'pipe', 'pipe'],
      detached: !WIN, windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    })
    let stdout = '', stderr = '', timedOut = false
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => {
      timedOut = true
      console.warn(`  !! timeout [${item.id}] after ${opts.timeoutSec}s`)
      killTree(proc)
    }, opts.timeoutSec * 1000)

    proc.on('close', (code) => {
      clearTimeout(timer)
      const secs = Math.round((Date.now() - t0) / 100) / 10
      writeFileSync(item.outFile, stdout, 'utf8')
      if (stderr) writeFileSync(item.errFile, stderr, 'utf8')

      // Parse the payload REGARDLESS of exit code: grok exits 1 on max-turns
      // but still prints a complete result document, including what it spent.
      let doc = null
      if (stdout) { try { doc = JSON.parse(stdout) } catch { doc = null } }

      // grok signals max-turns as exit 1 + stderr "max turns reached", and
      // reports stopReason "cancelled" — never "max_turns". Trust the marker.
      const maxTurnsHit = stderr.includes('max turns reached')
      const status = timedOut ? 'timeout'
        : maxTurnsHit ? 'truncated'
        : code !== 0 ? 'failed'
        : !doc ? 'unparsable'
        : 'ok'
      const turns = doc && doc.num_turns != null ? Number(doc.num_turns) : null
      // The fabrication tell: a task that needed a tool call but took a single
      // turn answered from prior knowledge.
      const suspect = status === 'ok' && turns != null && turns <= 1

      results[item.id] = {
        id: item.id, status, exitCode: code, seconds: secs,
        mode: item.mode, permissionMode: item.permMode, cwd: item.cwd,
        stopReason: doc ? doc.stopReason ?? null : null,
        numTurns: turns, suspectNoToolCall: suspect,
        sessionId: doc ? doc.sessionId ?? null : null,
        costUSD: doc ? doc.total_cost_usd ?? null : null,
        outputFile: item.outFile, errorFile: stderr ? item.errFile : null,
        after: item.after,
      }
      const marker = status === 'ok' ? (suspect ? 'OK? ' : 'OK  ') : 'FAIL'
      console.log(`  <- ${marker} [${item.id}] exit=${code} turns=${turns} ${secs}s`)
      resolve()
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      results[item.id] = {
        id: item.id, status: 'failed', exitCode: null, seconds: 0,
        mode: item.mode, permissionMode: item.permMode, cwd: item.cwd,
        stopReason: `spawn error: ${err.message}`, numTurns: null,
        suspectNoToolCall: false, sessionId: null, costUSD: null,
        outputFile: null, errorFile: null, after: item.after,
      }
      console.log(`  <- FAIL [${item.id}] spawn error: ${err.message}`)
      resolve()
    })
  })
}

let pending = [...plan]
const running = new Map()
while (pending.length > 0 || running.size > 0) {
  let progress = false
  const still = []
  for (const item of pending) {
    const unmet = item.after.find(d => !(d in results))
    const deadDep = unmet ? null : (item.afterAny ? null : item.after.find(d => results[d].status !== 'ok'))
    if (deadDep) {
      // Never verify a writer that never ran — the verdict would be meaningless.
      results[item.id] = {
        id: item.id, status: 'skipped', exitCode: null, seconds: 0,
        mode: item.mode, permissionMode: item.permMode, cwd: item.cwd,
        stopReason: `dependency '${deadDep}' ended ${results[deadDep].status}`,
        numTurns: null, suspectNoToolCall: false, sessionId: null, costUSD: null,
        outputFile: null, errorFile: null, after: item.after,
      }
      console.log(`  -- SKIP  [${item.id}] dependency '${deadDep}' ended ${results[deadDep].status}`)
      progress = true
    } else if (!unmet && running.size < opts.maxParallel) {
      const dep = item.after.length ? ` after=${item.after.join(',')}` : ''
      console.log(`  -> start [${item.id}] (${item.mode})${dep}`)
      running.set(item.id, runTask(item).then(() => running.delete(item.id)))
      progress = true
    } else {
      still.push(item)
    }
  }
  pending = still
  if (running.size > 0) await Promise.race(running.values())
  else if (pending.length > 0 && !progress) fail(`scheduler stalled with ${pending.length} task(s) pending and nothing running. Check the 'after' fields.`)
}

// Totals include failed and truncated tasks.
const totalCost = Object.values(results).reduce((s, r) => s + (r.costUSD ? Number(r.costUSD) : 0), 0)
const summary = {
  outDir: opts.outDir, model: opts.model, effort: opts.effort,
  permissionMode: opts.permissionMode, maxParallel: opts.maxParallel,
  totalSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  totalCostUSD: Math.round(totalCost * 1e5) / 1e5,
  ok: Object.values(results).filter(r => r.status === 'ok').length,
  failed: Object.values(results).filter(r => r.status !== 'ok').length,
  suspect: Object.values(results).filter(r => r.suspectNoToolCall).length,
  tasks: plan.map(p => results[p.id]),
}
const summaryPath = path.join(opts.outDir, '_summary.json')
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')

console.log('')
console.log(`grok-w: done in ${summary.totalSeconds}s -- ${summary.ok} ok, ${summary.failed} failed, ${summary.suspect} suspect`)
console.log(`grok-w: summary -> ${summaryPath}`)
for (const r of summary.tasks) {
  if (r.status !== 'ok') console.log(`grok-w: NEEDS ATTENTION [${r.id}] status=${r.status} stopReason=${r.stopReason}`)
  else if (r.suspectNoToolCall) console.log(`grok-w: SUSPECT [${r.id}] numTurns=${r.numTurns} -- no tool call; treat the answer as fabricated until you verify it yourself`)
}
process.exitCode = summary.failed > 0 ? 1 : 0
