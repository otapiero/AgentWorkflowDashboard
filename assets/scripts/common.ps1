# Shared helpers for Mission Control phase scripts.
#
# Everything here is deterministic bookkeeping. It runs inside the spawned
# terminal tab, which is what makes it independent of the app being alive.
#
# The project home is passed in rather than computed here. The app owns the
# rules for which project is active; a second implementation of that lookup in
# PowerShell would eventually disagree with the first.

function Get-TaskDir {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue
    )
    return (Join-Path (Join-Path $McHome 'tasks') $Issue)
}

function Get-MarkersDir {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue
    )
    return (Join-Path (Get-TaskDir -McHome $McHome -Issue $Issue) 'markers')
}

function Write-Marker {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue,
        [Parameter(Mandatory)][string]$Name,
        [string]$Body = ''
    )
    $dir = Get-MarkersDir -McHome $McHome -Issue $Issue
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -Path (Join-Path $dir $Name) -Value $Body -NoNewline -Encoding utf8
}

function Clear-Marker {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue,
        [Parameter(Mandatory)][string]$Name
    )
    $path = Join-Path (Get-MarkersDir -McHome $McHome -Issue $Issue) $Name
    if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
}

# Records that this phase is running, together with the PID of this very
# process. Storing the PID is what lets the app tell a live session apart from
# a terminal that was closed or crashed.
function Write-RunningMarker {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue,
        [Parameter(Mandatory)][string]$Phase
    )
    $payload = @{
        phase     = $Phase
        pid       = $PID
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress
    Write-Marker -McHome $McHome -Issue $Issue -Name "$Phase.running" -Body $payload
}

# Creates the task's isolated checkout if it is not already there.
# Always cuts from the latest base branch so the work does not start stale.
function Ensure-Worktree {
    param(
        [Parameter(Mandatory)][int]$Issue,
        [Parameter(Mandatory)][string]$Worktree,
        [Parameter(Mandatory)][string]$Branch,
        [Parameter(Mandatory)][string]$RepoPath,
        [Parameter(Mandatory)][string]$BaseBranch
    )

    if (Test-Path $Worktree) {
        $actualBranch = git -C $Worktree symbolic-ref --short HEAD
        if ($LASTEXITCODE -ne 0 -or $actualBranch -ne $Branch) {
            throw "Checkout branch does not match '$Branch'. No agent was launched."
        }
        Write-Host "[mc] worktree already present: $Worktree" -ForegroundColor DarkGray
        return
    }

    Write-Host "[mc] fetching origin/$BaseBranch" -ForegroundColor Cyan
    git -C $RepoPath fetch origin $BaseBranch | Out-Null

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Worktree) | Out-Null

    git -C $RepoPath show-ref --verify --quiet "refs/heads/$Branch"
    $branchExists = ($LASTEXITCODE -eq 0)

    if ($branchExists) {
        Write-Host "[mc] reusing existing branch $Branch" -ForegroundColor Cyan
        git -C $RepoPath worktree add $Worktree $Branch
    }
    else {
        Write-Host "[mc] creating branch $Branch from origin/$BaseBranch" -ForegroundColor Cyan
        git -C $RepoPath worktree add -b $Branch $Worktree "origin/$BaseBranch"
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create worktree at $Worktree. Run 'git worktree list' in $RepoPath to inspect."
    }
}
