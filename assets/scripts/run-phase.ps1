# Mission Control — run one pipeline phase.
#
# setup (deterministic) -> agent (interactive) -> cleanup (deterministic)
#
# This is the only script that launches an agent. It is parameterised by a
# spec file rather than by phase, because every phase has the same shape and
# differs only in its arguments. Crucially it runs in its own terminal tab, so
# it completes whether or not the Mission Control app is still alive.

param(
    [Parameter(Mandatory)][string]$SpecFile,
    # Set by the VS Code launcher only. The workspace's folderOpen task fires on
    # every open, so this file is how we run the agent exactly once: create it on
    # the first run, bail out on any later open. Mission Control deletes it when
    # it deliberately launches the phase again.
    [string]$GuardFile
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\common.ps1"

if (-not (Test-Path $SpecFile)) {
    throw "Spawn spec not found: $SpecFile"
}
$spec = Get-Content -Raw $SpecFile | ConvertFrom-Json

$issue = [int]$spec.issue
$phase = [string]$spec.phase

Write-Host ""
Write-Host "  Mission Control - issue #$issue - $phase" -ForegroundColor Green
Write-Host "  branch: $($spec.branch)" -ForegroundColor DarkGray
Write-Host ""

# One-shot guard for the VS Code launcher. If the guard file already exists this
# is a re-open (or VS Code restoring the window), so do nothing but keep the tab.
if ($GuardFile) {
    if (Test-Path $GuardFile) {
        Write-Host "[mc] This phase was already launched from this workspace; not re-running." -ForegroundColor DarkGray
        Write-Host "[mc] Relaunch it from Mission Control if you want to run it again." -ForegroundColor DarkGray
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $GuardFile) | Out-Null
    Set-Content -Path $GuardFile -Value ((Get-Date).ToUniversalTime().ToString('o')) -NoNewline -Encoding utf8
}

# --- setup ---------------------------------------------------------------
Ensure-Worktree -Issue $issue -Worktree $spec.worktree -Branch $spec.branch `
    -RepoPath $spec.repoPath -BaseBranch $spec.baseBranch

Write-RunningMarker -Issue $issue -Phase $phase

# The agent needs to know which task it is on if it ever asks.
$env:MC_ISSUE = $issue
$env:MC_PHASE = $phase

try {
    Set-Location $spec.worktree

    if (-not (Test-Path $spec.promptFile)) {
        throw "Prompt file not found: $($spec.promptFile)"
    }
    $prompt = Get-Content -Raw $spec.promptFile

    # Substitute the prompt into the prepared argument list. Passing the args
    # as an array (splatting) is what keeps quotes and newlines in the prompt
    # intact — building a single command string would mangle them.
    $agentArgs = @($spec.args | ForEach-Object {
            if ($_ -eq $spec.promptToken) { $prompt } else { $_ }
        })

    Write-Host "[mc] launching $($spec.exe)" -ForegroundColor Cyan
    Write-Host ""

    & $spec.exe @agentArgs
}
finally {
    # Always clear the running marker, even on Ctrl-C or a thrown error, so a
    # finished session never leaves the card showing "live" forever.
    Clear-Marker -Issue $issue -Name "$phase.running"

    Write-Host ""
    Write-Host "[mc] $phase session ended for #$issue." -ForegroundColor Green
    if (Test-Path (Join-Path (Get-TaskDir $issue) 'plan.md')) {
        Write-Host "[mc] plan.md is attached; Mission Control will pick it up on refresh." -ForegroundColor DarkGray
    }
    Write-Host "[mc] This tab stays open so you can read the output. Close it when done." -ForegroundColor DarkGray
}
