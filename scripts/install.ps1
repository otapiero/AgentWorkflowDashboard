# Mission Control installer.
#
# Seeds %USERPROFILE%\.mc\ and installs the user-scoped mc-* command
# files. Nothing is ever written into the Acme repo.
#
# Safe to re-run: scripts and commands are refreshed, config.yaml is never
# overwritten once it exists.

[CmdletBinding()]
param(
    [switch]$Force  # overwrite an existing config.yaml
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $repoRoot 'assets'

$mcHome = if ($env:MC_HOME) { $env:MC_HOME } else { Join-Path $env:USERPROFILE '.mc' }
$claudeCommands = Join-Path $env:USERPROFILE '.claude\commands'

Write-Host ""
Write-Host "Mission Control installer" -ForegroundColor Green
Write-Host "  home:     $mcHome"
Write-Host "  commands: $claudeCommands"
Write-Host ""

foreach ($dir in @($mcHome, (Join-Path $mcHome 'scripts'), (Join-Path $mcHome 'tasks'), (Join-Path $mcHome 'worktrees'), $claudeCommands)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# --- phase scripts -------------------------------------------------------
Get-ChildItem (Join-Path $assets 'scripts') -Filter *.ps1 | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $mcHome 'scripts') -Force
    Write-Host "  script   $($_.Name)" -ForegroundColor DarkGray
}

# --- user-scoped command files ------------------------------------------
# These stay the single editable source of prompt text. Mission Control reads
# them at spawn time, renders the task context in, and passes the result to the
# agent verbatim.
Get-ChildItem (Join-Path $assets 'claude\commands') -Filter *.md | ForEach-Object {
    Copy-Item $_.FullName $claudeCommands -Force
    Write-Host "  command  /$($_.BaseName)" -ForegroundColor DarkGray
}

# --- config --------------------------------------------------------------
$configPath = Join-Path $mcHome 'config.yaml'
if ((Test-Path $configPath) -and -not $Force) {
    Write-Host "  config   kept existing config.yaml (use -Force to replace)" -ForegroundColor Yellow
}
else {
    Copy-Item (Join-Path $assets 'config.example.yaml') $configPath -Force
    Write-Host "  config   wrote config.yaml" -ForegroundColor DarkGray
}

# --- sanity checks -------------------------------------------------------
Write-Host ""
$problems = @()

foreach ($tool in @('git', 'gh', 'wt', 'pwsh')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        $problems += "$tool was not found on PATH"
    }
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { $problems += 'gh is not authenticated (run: gh auth login)' }

$repoPath = (Select-String -Path $configPath -Pattern "^\s*path:\s*'(.+)'" | Select-Object -First 1).Matches.Groups[1].Value
if (-not (Test-Path $repoPath)) {
    $problems += "repo.path in config.yaml does not exist: $repoPath"
}

# T3 Code is optional: the t3 launcher needs it, wt and vscode do not.
$t3Runtime = Join-Path $env:USERPROFILE '.t3\userdata\server-runtime.json'
if (Test-Path $t3Runtime) {
    Write-Host "  ok: T3 Code state found at $t3Runtime"
    $t3Credential = Join-Path $env:USERPROFILE '.mc\t3-credential'
    $t3Token = Join-Path $env:USERPROFILE '.mc\t3-token.json'
    if (-not (Test-Path $t3Credential) -and -not (Test-Path $t3Token)) {
        Write-Host "  note: no T3 credential yet. The 't3' launcher needs one."
        Write-Host "        In T3: Settings -> This environment -> Authorized clients -> Create link."
        # Keep this block ASCII-only. Windows PowerShell 5.1 reads a .ps1 with
        # no BOM as ANSI, so a UTF-8 em-dash arrives as bytes ending in 0x94 --
        # a curly close-quote, which PowerShell accepts as a string terminator.
        # The result is a parser error tens of lines further down.
        Write-Host "        Save the 'This machine' URL to $t3Credential straight away:"
        Write-Host "        the link is single-use and expires within about three minutes."
    }
}
else {
    Write-Host "  note: T3 Code not detected. The 'wt' and 'vscode' launchers work without it."
}

if ($problems.Count -eq 0) {
    Write-Host "All checks passed." -ForegroundColor Green
}
else {
    Write-Host "Check the following:" -ForegroundColor Yellow
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "Next: npm run dev" -ForegroundColor Green
Write-Host ""
