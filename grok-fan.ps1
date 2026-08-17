<#
.SYNOPSIS
  Grok-W dispatch runner: executes a dependency-ordered batch of Grok Build tasks in parallel.

.DESCRIPTION
  Reads a JSON task array, launches up to -MaxParallel `grok` processes concurrently,
  honours per-task dependencies ("after"), and writes one result file per task plus a
  machine-readable _summary.json.

  Designed to be driven by an orchestrator -- whichever agent is running the workflow,
  the model does not matter -- that plans the tasks, reviews the results and owns all
  final judgement. Grok subagents are stateless workers: every prompt must be fully
  self-contained.

  "after" exists so one task file can hold a whole build round: a WRITER task that
  implements an item, and a blind VERIFIER task that runs afterwards and judges the
  result from disk state and a proof command. The runner never feeds a dependency's
  output into a dependent prompt -- that blindness is the point. A verifier that is
  shown the writer's own claims is not a verifier.

  Three measured facts drive this script's defaults -- see SKILL.md "Measured behaviour":

  1. --permission-mode auto is REQUIRED for any task that writes or runs commands.
     Under 'dontAsk', 'default' or 'acceptEdits', grok CANCELS the tool call: the
     session ends at turn 1 with stopReason "cancelled", exit code 0 and no stderr,
     so a write task reports success while nothing reached the disk. Writing modes
     are rejected up front unless the mode is 'auto'.
  2. numTurns == 1 on a task that needed a tool call means the answer was fabricated.
     grok-4.6 will invent schema-valid results rather than call a tool when the answer
     looks knowable. Those are flagged suspectNoToolCall.
  3. max-turns exits 1 with stderr "max turns reached" and reports stopReason
     "cancelled", never "max_turns" -- detected here via the stderr marker, and the
     payload is still parsed so its cost is counted.

  MODEL AND EFFORT ARE FIXED: grok-4.6 at xhigh, always. This is a standing
  instruction, not a default. 'xhigh' is confirmed to be the top of grok's ladder --
  the CLI rejects anything higher with "unknown effort level 'max'; use one of:
  xhigh, high, medium, low". The -Model and -Effort parameters accept only those two
  values so a wrong call fails loudly, and per-task 'model'/'effort' overrides in a
  task file are refused rather than silently applied.

.PARAMETER TasksFile
  Path to a JSON file containing an array of task objects. Fields:
    id              (string, required)  unique, filename-safe
    prompt          (string, required)  fully self-contained instruction
    cwd             (string)            working dir for the subagent (default: -DefaultCwd)
    mode            (string)            read | write | shell | full   (default: read)
    after           (string|string[])   task id(s) that must finish before this one starts
    afterAny        (bool)              run even if a dependency did not end 'ok'
    maxTurns        (int)               default: 40 for read, 80 otherwise
    schema          (object)            JSON Schema -> forces structured JSON output
    tools           (string)            explicit comma-separated tool allowlist (overrides mode)
    rules           (string)            extra system-prompt rules
    permissionMode  (string)            overrides -PermissionMode for this task
    resumeSessionId (string)            resume that grok session instead of starting fresh
    continueSession (bool)              resume the most recent session for this cwd
    allowSubagents  (bool)              let Grok spawn its own subagents (default: false)

.PARAMETER OutDir
  Directory for results. Created if missing. Defaults to a timestamped dir under
  $env:TEMP\grok-w\.

.PARAMETER PermissionMode
  Wave-wide grok permission mode. Default 'auto' -- the only mode in which write,
  search_replace and run_terminal_command actually execute. 'dontAsk' is accepted for
  waves of pure read tasks, where it makes an accidental write a no-op; it fails
  SILENTLY, so it is refused for write/shell/full tasks.

.EXAMPLE
  .\grok-fan.ps1 -TasksFile .\round1.json -OutDir D:\tmp\r1 -MaxParallel 10
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TasksFile,
    [string]$OutDir,
    [ValidateRange(1, 10)][int]$MaxParallel = 10,
    # Pinned by standing instruction: grok-4.6 at xhigh, never anything else.
    # Kept as parameters so existing correct call sites keep working, but the
    # ValidateSets make any other value a loud failure instead of a quiet downgrade.
    [ValidateSet('grok-4.6')][string]$Model = 'grok-4.6',
    [ValidateSet('xhigh')][string]$Effort = 'xhigh',
    [ValidateSet('auto', 'dontAsk', 'default', 'acceptEdits')][string]$PermissionMode = 'auto',
    [string]$DefaultCwd = (Get-Location).Path,
    [int]$TimeoutSec = 1800,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$env:NO_COLOR = '1'

# --- locate the grok entrypoint -------------------------------------------------
# Invoke the packaged node script directly. The npm .cmd/.ps1 shims re-parse
# arguments and destroy embedded quotes, which breaks --json-schema.
function Resolve-GrokEntry {
    $candidates = @(
        (Join-Path $env:APPDATA 'npm\node_modules\@xai-official\grok\bin\grok'),
        (Join-Path $env:LOCALAPPDATA 'npm\node_modules\@xai-official\grok\bin\grok')
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    $cmd = Get-Command grok -ErrorAction SilentlyContinue
    if ($cmd) {
        $guess = Join-Path (Split-Path $cmd.Source -Parent) 'node_modules\@xai-official\grok\bin\grok'
        if (Test-Path -LiteralPath $guess) { return $guess }
    }
    throw "Could not locate the Grok Build entrypoint. Is '@xai-official/grok' installed globally?"
}

$grokEntry = Resolve-GrokEntry
$nodeExe = (Get-Command node -ErrorAction Stop).Source

# --- Windows command-line escaping (CommandLineToArgvW rules) -------------------
function ConvertTo-WinArg {
    param([string]$Value)
    if ($null -eq $Value) { $Value = '' }
    if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') {
            $backslashes++
            continue
        }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * (2 * $backslashes + 1))
            [void]$sb.Append('"')
        }
        else {
            [void]$sb.Append('\' * $backslashes)
            [void]$sb.Append($ch)
        }
        $backslashes = 0
    }
    [void]$sb.Append('\' * (2 * $backslashes))
    [void]$sb.Append('"')
    return $sb.ToString()
}

# --- tool profiles --------------------------------------------------------------
# Verified tool names (grok 1.0.4): confirmed both in the decompressed binary and in
# the agent's own tool list. NOTE: grok silently IGNORES an unknown name in --tools,
# so a typo here costs the subagent that tool with no error anywhere.
$ToolProfiles = @{
    'read'  = 'read_file,list_dir,grep'
    'write' = 'read_file,list_dir,grep,write,search_replace'
    'shell' = 'read_file,list_dir,grep,run_terminal_command'
    'full'  = 'read_file,list_dir,grep,write,search_replace,run_terminal_command'
}

# Modes that cannot work unless the permission mode is 'auto'.
# 'shell' is here too: run_terminal_command is cancelled the same way write is.
$WritingModes = @('write', 'shell', 'full')

# --- load tasks -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $TasksFile)) { throw "Tasks file not found: $TasksFile" }
$raw = Get-Content -LiteralPath $TasksFile -Raw -Encoding UTF8
# Direct assignment, not a pipeline: PS 5.1's ConvertFrom-Json emits a JSON array as
# a single object, so `@(... | ConvertFrom-Json)` yields an array-of-one-array.
$parsed = ConvertFrom-Json -InputObject $raw
$tasks = @($parsed)
if ($tasks.Count -eq 1 -and $tasks[0] -is [System.Array]) { $tasks = @($tasks[0]) }
if ($tasks.Count -eq 0) { throw "Tasks file contains no tasks: $TasksFile" }

$seen = @{}
foreach ($t in $tasks) {
    if (-not ($t.id -is [string]) -or [string]::IsNullOrWhiteSpace($t.id)) {
        throw "Every task needs a string 'id'. The tasks file must be a JSON array of task objects."
    }
    if (-not ($t.prompt -is [string]) -or [string]::IsNullOrWhiteSpace($t.prompt)) {
        throw "Task '$($t.id)' has no string 'prompt'."
    }
    if ($t.id -match '[\\/:*?"<>|]') { throw "Task id '$($t.id)' contains characters that are illegal in filenames." }
    if ($seen.ContainsKey($t.id)) { throw "Duplicate task id: $($t.id)" }
    # Refuse instead of ignore: a silently dropped override is exactly the class of
    # failure this runner exists to prevent.
    if ($null -ne $t.model) {
        throw "Task '$($t.id)': per-task 'model' is not allowed. Grok-W runs grok-4.6 exclusively; remove the field."
    }
    if ($null -ne $t.effort) {
        throw "Task '$($t.id)': per-task 'effort' is not allowed. Grok-W runs at xhigh exclusively (the top of grok's ladder); remove the field."
    }
    $seen[$t.id] = $true
}

# --- validate the dependency graph ---------------------------------------------
$afterMap = @{}
foreach ($t in $tasks) {
    $deps = @()
    if ($t.after) { $deps = @($t.after) | Where-Object { $_ } | ForEach-Object { [string]$_ } }
    foreach ($d in $deps) {
        if (-not $seen.ContainsKey($d)) { throw "Task '$($t.id)': 'after' names unknown task '$d'." }
        if ($d -eq $t.id) { throw "Task '$($t.id)': 'after' cannot reference itself." }
    }
    $afterMap[[string]$t.id] = $deps
}
# Kahn's algorithm -- a cycle would deadlock the scheduler, so reject it up front.
$indeg = @{}
foreach ($k in $afterMap.Keys) { $indeg[$k] = $afterMap[$k].Count }
$ready = [System.Collections.Queue]::new()
foreach ($k in $indeg.Keys) { if ($indeg[$k] -eq 0) { $ready.Enqueue($k) } }
$sorted = 0
while ($ready.Count -gt 0) {
    $k = $ready.Dequeue(); $sorted++
    foreach ($other in $afterMap.Keys) {
        if ($afterMap[$other] -contains $k) {
            $indeg[$other] = $indeg[$other] - 1
            if ($indeg[$other] -eq 0) { $ready.Enqueue($other) }
        }
    }
}
if ($sorted -ne $afterMap.Count) { throw "The 'after' fields form a cycle. Fix the task file." }

if (-not $OutDir) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutDir = Join-Path $env:TEMP "grok-w\$stamp"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$promptDir = Join-Path $OutDir '_prompts'
New-Item -ItemType Directory -Force -Path $promptDir | Out-Null

# --- build invocations ----------------------------------------------------------
$plan = @()
foreach ($t in $tasks) {
    $mode = if ($t.mode) { [string]$t.mode } else { 'read' }
    if (-not $ToolProfiles.ContainsKey($mode)) {
        throw "Task '$($t.id)': unknown mode '$mode' (use read|write|shell|full)."
    }
    $tools = if ($t.tools) { [string]$t.tools } else { $ToolProfiles[$mode] }
    $cwd = if ($t.cwd) { [string]$t.cwd } else { $DefaultCwd }
    if (-not (Test-Path -LiteralPath $cwd)) { throw "Task '$($t.id)': cwd does not exist: $cwd" }
    $maxTurns = if ($t.maxTurns) { [int]$t.maxTurns } elseif ($mode -eq 'read') { 40 } else { 80 }
    $permMode = if ($t.permissionMode) { [string]$t.permissionMode } else { $PermissionMode }

    # Fail loudly instead of dispatching a task that reports success and changes nothing.
    if ($WritingModes -contains $mode -and $permMode -ne 'auto') {
        throw ("Task '$($t.id)': mode '$mode' needs permissionMode 'auto' (got '$permMode'). " +
               "Any other mode cancels write/search_replace/run_terminal_command silently -- " +
               "the task would report success with nothing written. Set permissionMode 'auto' " +
               "on the task, or run the wave with -PermissionMode auto.")
    }

    $promptPath = Join-Path $promptDir "$($t.id).txt"
    Set-Content -LiteralPath $promptPath -Value ([string]$t.prompt) -Encoding UTF8

    $argv = New-Object System.Collections.Generic.List[string]
    $argv.Add($grokEntry)
    # Resume must precede the prompt so the session is selected before the turn runs.
    if ($t.resumeSessionId) { $argv.Add('--resume'); $argv.Add([string]$t.resumeSessionId) }
    elseif ($t.continueSession) { $argv.Add('--continue') }
    $argv.Add('--prompt-file'); $argv.Add($promptPath)
    $argv.Add('--cwd'); $argv.Add($cwd)
    $argv.Add('--model'); $argv.Add($Model)
    $argv.Add('--reasoning-effort'); $argv.Add($Effort)
    $argv.Add('--tools'); $argv.Add($tools)
    $argv.Add('--max-turns'); $argv.Add([string]$maxTurns)
    # Headless hygiene: never block on a prompt, never re-plan, never recurse.
    $argv.Add('--permission-mode'); $argv.Add($permMode)
    $argv.Add('--deny'); $argv.Add('ask_user_question')
    $argv.Add('--no-plan')
    $argv.Add('--no-memory')
    if (-not $t.allowSubagents) { $argv.Add('--no-subagents') }
    if ($t.rules) { $argv.Add('--rules'); $argv.Add([string]$t.rules) }
    if ($t.schema) {
        $argv.Add('--json-schema'); $argv.Add(($t.schema | ConvertTo-Json -Depth 30 -Compress))
    }
    else {
        $argv.Add('--output-format'); $argv.Add('json')
    }

    $cmdline = ($argv | ForEach-Object { ConvertTo-WinArg $_ }) -join ' '
    $plan += [pscustomobject]@{
        Id       = [string]$t.id
        Mode     = $mode
        Cwd      = $cwd
        PermMode = $permMode
        After    = $afterMap[[string]$t.id]
        AfterAny = [bool]$t.afterAny
        CmdLine  = $cmdline
        OutFile  = (Join-Path $OutDir "$($t.id).json")
        ErrFile  = (Join-Path $OutDir "$($t.id).err.txt")
    }
}

if ($DryRun) {
    $plan | ForEach-Object {
        $dep = if ($_.After.Count) { " after=$($_.After -join ',')" } else { '' }
        "[$($_.Id)]$dep $nodeExe $($_.CmdLine)"
    }
    return
}

# --- run with a concurrency throttle, honouring dependencies --------------------
Write-Host "grok-w: $($plan.Count) task(s), max $MaxParallel parallel, model=$Model effort=$Effort perm=$PermissionMode"
Write-Host "grok-w: results -> $OutDir"

$pending = New-Object System.Collections.ArrayList
foreach ($p in $plan) { [void]$pending.Add($p) }
$running = @()
$results = @{}
$startedAt = Get-Date

function Start-GrokTask {
    param($Item)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = $Item.CmdLine
    $psi.WorkingDirectory = $Item.Cwd
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    # Async reads prevent a full pipe buffer from deadlocking the child.
    return [pscustomobject]@{
        Item    = $Item
        Proc    = $p
        OutTask = $p.StandardOutput.ReadToEndAsync()
        ErrTask = $p.StandardError.ReadToEndAsync()
        Started = (Get-Date)
    }
}

while ($pending.Count -gt 0 -or $running.Count -gt 0) {
    # --- schedule whatever is ready -------------------------------------------
    $progress = $false
    $stillPending = New-Object System.Collections.ArrayList
    foreach ($item in $pending) {
        $blocked = $false
        $deadDep = $null
        foreach ($d in $item.After) {
            if (-not $results.ContainsKey($d)) { $blocked = $true; break }
            if ((-not $item.AfterAny) -and $results[$d].status -ne 'ok') { $deadDep = $d; break }
        }
        if ($deadDep) {
            # Never verify a writer that never ran -- the verdict would be meaningless.
            $results[$item.Id] = [pscustomobject]@{
                id = $item.Id; status = 'skipped'; exitCode = $null; seconds = 0
                mode = $item.Mode; permissionMode = $item.PermMode; cwd = $item.Cwd
                stopReason = "dependency '$deadDep' ended $($results[$deadDep].status)"
                numTurns = $null; suspectNoToolCall = $false; sessionId = $null
                costUSD = $null; outputFile = $null; errorFile = $null
                after = $item.After
            }
            Write-Host "  -- SKIP  [$($item.Id)] dependency '$deadDep' ended $($results[$deadDep].status)"
            $progress = $true
            continue
        }
        if ((-not $blocked) -and $running.Count -lt $MaxParallel) {
            $dep = if ($item.After.Count) { " after=$($item.After -join ',')" } else { '' }
            Write-Host "  -> start [$($item.Id)] ($($item.Mode))$dep"
            $running += (Start-GrokTask -Item $item)
            $progress = $true
        }
        else { [void]$stillPending.Add($item) }
    }
    $pending = $stillPending

    if ($pending.Count -gt 0 -and $running.Count -eq 0 -and -not $progress) {
        throw "Scheduler stalled with $($pending.Count) task(s) pending and nothing running. Check the 'after' fields."
    }

    # --- reap finished processes ----------------------------------------------
    Start-Sleep -Milliseconds 400
    $stillRunning = @()
    foreach ($r in $running) {
        $timedOut = ((Get-Date) - $r.Started).TotalSeconds -gt $TimeoutSec
        if ($timedOut -and -not $r.Proc.HasExited) {
            try { $r.Proc.Kill() } catch { }
            Write-Warning "  !! timeout [$($r.Item.Id)] after ${TimeoutSec}s"
        }
        if (-not $r.Proc.HasExited) { $stillRunning += $r; continue }

        $stdout = $r.OutTask.Result
        $stderr = $r.ErrTask.Result
        Set-Content -LiteralPath $r.Item.OutFile -Value $stdout -Encoding UTF8
        if ($stderr) { Set-Content -LiteralPath $r.Item.ErrFile -Value $stderr -Encoding UTF8 }

        $secs = [math]::Round(((Get-Date) - $r.Started).TotalSeconds, 1)
        $code = $r.Proc.ExitCode

        # Parse the payload REGARDLESS of exit code: grok exits 1 on max-turns but
        # still prints a complete result document, including what it spent.
        $doc = $null
        if ($stdout) { try { $doc = ConvertFrom-Json -InputObject $stdout } catch { $doc = $null } }

        $cost = $null; $stopReason = $null; $turns = $null; $sessionId = $null
        if ($doc) {
            $cost = $doc.total_cost_usd
            $stopReason = $doc.stopReason
            $turns = $doc.num_turns
            $sessionId = $doc.sessionId
        }

        # grok signals max-turns as exit 1 + stderr "max turns reached", and reports
        # stopReason "cancelled" -- never "max_turns". Trust the stderr marker.
        $maxTurnsHit = ($stderr -and $stderr -match 'max turns reached')

        $status =
            if ($timedOut) { 'timeout' }
            elseif ($maxTurnsHit) { 'truncated' }
            elseif ($code -ne 0) { 'failed' }
            elseif (-not $doc) { 'unparsable' }
            else { 'ok' }

        # The fabrication tell: a task that needed a tool call but took a single turn
        # answered from prior knowledge. Cheap, mechanical, and in testing perfectly
        # correlated with invented results.
        $suspect = ($status -eq 'ok' -and $null -ne $turns -and [int]$turns -le 1)

        $results[$r.Item.Id] = [pscustomobject]@{
            id                = $r.Item.Id
            status            = $status
            exitCode          = $code
            seconds           = $secs
            mode              = $r.Item.Mode
            permissionMode    = $r.Item.PermMode
            cwd               = $r.Item.Cwd
            stopReason        = $stopReason
            numTurns          = $turns
            suspectNoToolCall = $suspect
            sessionId         = $sessionId
            costUSD           = $cost
            outputFile        = $r.Item.OutFile
            errorFile         = if ($stderr) { $r.Item.ErrFile } else { $null }
            after             = $r.Item.After
        }
        $marker = if ($status -eq 'ok') { if ($suspect) { 'OK? ' } else { 'OK  ' } } else { 'FAIL' }
        Write-Host "  <- $marker [$($r.Item.Id)] exit=$code turns=$turns ${secs}s"
        $r.Proc.Dispose()
    }
    $running = $stillRunning
}

# Count every dollar grok reported, including failed and truncated tasks --
# they cost real money even when their output is unusable.
$totalCost = 0.0
foreach ($v in $results.Values) { if ($v.costUSD) { $totalCost += [double]$v.costUSD } }

$summary = [pscustomobject]@{
    outDir         = $OutDir
    model          = $Model
    effort         = $Effort
    permissionMode = $PermissionMode
    maxParallel    = $MaxParallel
    totalSeconds   = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
    totalCostUSD   = [math]::Round($totalCost, 5)
    ok             = @($results.Values | Where-Object { $_.status -eq 'ok' }).Count
    failed         = @($results.Values | Where-Object { $_.status -ne 'ok' }).Count
    suspect        = @($results.Values | Where-Object { $_.suspectNoToolCall }).Count
    tasks          = @($plan | ForEach-Object { $results[$_.Id] })
}
$summaryPath = Join-Path $OutDir '_summary.json'
$summary | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host ""
Write-Host "grok-w: done in $($summary.totalSeconds)s -- $($summary.ok) ok, $($summary.failed) failed, $($summary.suspect) suspect, `$$($summary.totalCostUSD)"
Write-Host "grok-w: summary -> $summaryPath"
foreach ($v in $summary.tasks) {
    if ($v.status -ne 'ok') { Write-Host "grok-w: NEEDS ATTENTION [$($v.id)] status=$($v.status) stopReason=$($v.stopReason)" }
    elseif ($v.suspectNoToolCall) { Write-Host "grok-w: SUSPECT [$($v.id)] numTurns=$($v.numTurns) -- no tool call; treat the answer as fabricated until you verify it yourself" }
}
if ($summary.failed -gt 0) { exit 1 }
