# Mission Control — run one pipeline phase.
# mc-launch-protocol: 2
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

$mcHome = [string]$spec.mcHome
if (-not $mcHome) {
    throw "Spawn spec has no mcHome. It was written by an older Mission Control; relaunch the phase from the board."
}

Write-Host ""
Write-Host "  Mission Control - issue #$issue - $phase" -ForegroundColor Green
Write-Host "  branch: $($spec.branch)" -ForegroundColor DarkGray
Write-Host ""

# Rebuild PATH from the registry. A newly installed agent CLI adds itself to the
# user PATH, but every process already running — Explorer, VS Code, and so this
# tab — keeps the environment block it was born with, so the agent stays
# invisible until the next sign-out. Reading the persisted value gives a fresh
# tab the PATH the machine actually has.
$env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

# Resolve the agent now rather than at launch time. Failing here costs nothing;
# failing after the worktree and the running marker are in place buries a
# one-line "not recognized" under a whole session's output.
if (-not (Get-Command $spec.exe -ErrorAction SilentlyContinue)) {
    throw "Agent executable '$($spec.exe)' was not found on PATH. Install it, or point the agent's launch: at its full path in config.yaml."
}

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

$launchReservation = Join-Path (Get-TaskDir -McHome $mcHome -Issue $issue) 'launch-pending.json'
if ($spec.launchToken) {
    # Cancellation removes the token. An old delayed terminal must never consume
    # another run's prompt. Hold an exclusive handle across the live-marker handoff.
    $reservationStream = [IO.File]::Open($launchReservation, 'Open', 'ReadWrite', 'None')
    try {
        $reservationReader = [IO.StreamReader]::new($reservationStream, [Text.Encoding]::UTF8, $true, 1024, $true)
        $reservation = $reservationReader.ReadToEnd() | ConvertFrom-Json
        $reservationReader.Dispose()
        if ($reservation.token -ne $spec.launchToken) { throw 'This launch was cancelled.' }
        Write-RunningMarker -McHome $mcHome -Issue $issue -Phase $phase
    }
    finally { $reservationStream.Dispose() }
    Remove-Item -LiteralPath $launchReservation -Force -ErrorAction SilentlyContinue
}
else { Write-RunningMarker -McHome $mcHome -Issue $issue -Phase $phase }

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
    Clear-Marker -McHome $mcHome -Issue $issue -Name "$phase.running"

    Write-Host ""
    Write-Host "[mc] $phase session ended for #$issue." -ForegroundColor Green
    if (Test-Path (Join-Path (Get-TaskDir -McHome $mcHome -Issue $issue) 'plan.md')) {
        Write-Host "[mc] plan.md is attached; Mission Control will pick it up on refresh." -ForegroundColor DarkGray
    }
    Write-Host "[mc] This tab stays open so you can read the output. Close it when done." -ForegroundColor DarkGray
}
