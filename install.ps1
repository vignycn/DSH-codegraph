<#
.SYNOPSIS
    Wire the CodeGraph MCP server into a DeepSeek Harness (DSH) profile.

.DESCRIPTION
    Appends an `insert:` entry to the profile's cordis.patch.yml so DSH's
    bundled @deepseek-ai/dsh-mcp-client connects to `codegraph serve --mcp`.
    The previous file is backed up, and any earlier mcp-codegraph block is
    replaced, so the script is safe to re-run.

    DSH hot-reloads this file: no restart is needed after running it.

.PARAMETER ProjectPath
    Directory CodeGraph has indexed (must contain .codegraph/).

.PARAMETER Profile
    DSH profile name under ~/.dsh/profiles. Default: desktop.

.EXAMPLE
    .\install.ps1 -ProjectPath N:\Code\my-project

.EXAMPLE
    .\install.ps1 -ProjectPath C:\src\app -Profile work
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ProjectPath,

    [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

# ---------- 1. validate the project ----------
if (-not (Test-Path -LiteralPath $ProjectPath)) {
    throw "Project path does not exist: $ProjectPath"
}
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path

$indexDir = Join-Path $ProjectPath '.codegraph'
if (-not (Test-Path -LiteralPath $indexDir)) {
    Write-Warning "No .codegraph/ found in $ProjectPath"
    Write-Warning "Run 'codegraph init' there first, or the tool will answer: 'No CodeGraph project is loaded for this session.'"
}

# ---------- 1b. validate that the CodeGraph runtime can be resolved ----------
# Mirrors what the patch's !!js expression resolves at load time.
$cgRoot = if ($env:CODEGRAPH_INSTALL_DIR) { $env:CODEGRAPH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'codegraph' }
$cgNode = Join-Path $cgRoot 'current\node.exe'
$cgCli = Join-Path $cgRoot 'current\lib\dist\bin\codegraph.js'
if (-not (Test-Path -LiteralPath $cgNode) -or -not (Test-Path -LiteralPath $cgCli)) {
    Write-Warning "CodeGraph runtime not found under: $cgRoot\current"
    Write-Warning "Install CodeGraph first, or set CODEGRAPH_INSTALL_DIR to its install root."
    Write-Warning "Without it the plugin still activates, but exposes no tools."
}
else {
    Write-Host "CodeGraph runtime: $cgNode" -ForegroundColor DarkGray
}

# ---------- 2. locate the profile patch layer ----------
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$patchPath = Join-Path $dshHome "profiles\$Profile\cordis.patch.yml"

if (-not (Test-Path -LiteralPath $patchPath)) {
    throw @"
Profile patch file not found:
  $patchPath

Start DeepSeek Harness once so it creates the profile, or pass -Profile <name>.
Existing profiles: $((Get-ChildItem (Join-Path $dshHome 'profiles') -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', ')
"@
}

# ---------- 3. read the template that ships next to this script ----------
$templatePath = Join-Path $PSScriptRoot 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "Template missing: $templatePath (keep install.ps1 and cordis.patch.yml together)"
}

$template = [System.IO.File]::ReadAllText($templatePath, [System.Text.Encoding]::UTF8)

# Anchor the marker to its own line: the template's prose also mentions it.
$markerMatch = [regex]::Match($template, '(?m)^--- cut here ---[ \t]*\r?\n')
if (-not $markerMatch.Success) {
    throw "Template is missing a '--- cut here ---' line."
}
$block = $template.Substring($markerMatch.Index + $markerMatch.Length)

# YAML single-quoted scalar: a literal ' is escaped by doubling it.
$yamlPath = $ProjectPath.Replace("'", "''")
$block = $block.Replace('REPLACE_WITH_PROJECT_PATH', $yamlPath)

if ($block.Contains('REPLACE_WITH_PROJECT_PATH')) {
    throw 'Path substitution failed; the template placeholder is still present.'
}

# ---------- 4. back up ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$patchPath.bak-$stamp"
Copy-Item -LiteralPath $patchPath -Destination $backup
Write-Host "Backup: $backup" -ForegroundColor DarkGray

# ---------- 5. drop any previous mcp-codegraph insert block ----------
$lines = [System.IO.File]::ReadAllLines($patchPath, [System.Text.Encoding]::UTF8)
$kept = New-Object System.Collections.Generic.List[string]
$removed = 0
$i = 0
while ($i -lt $lines.Count) {
    if ($lines[$i] -match '^- insert:\s*$') {
        $j = $i + 1
        while ($j -lt $lines.Count -and $lines[$j] -notmatch '^- ') { $j++ }
        $candidate = ($lines[$i..($j - 1)] -join "`n")
        if ($candidate -match 'mcp-codegraph') {
            $i = $j
            $removed++
            continue
        }
    }
    $kept.Add($lines[$i])
    $i++
}
if ($removed -gt 0) {
    Write-Host "Replaced $removed existing mcp-codegraph block(s)." -ForegroundColor DarkGray
}

# ---------- 6. drop a top-level empty-list document ----------
$body = ($kept -join "`n")
$body = [regex]::Replace($body, '(?m)^[ \t]*\[\][ \t]*\r?\n?', '')
$body = $body.TrimEnd()

if ($body.Length -gt 0) {
    $body = $body + "`n`n"
}
$result = $body + $block.TrimEnd() + "`n"

# ---------- 7. write UTF-8 without BOM (a BOM can upset YAML parsers) ----------
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($patchPath, $result, $utf8NoBom)

Write-Host ""
Write-Host "Installed: $patchPath" -ForegroundColor Green
Write-Host "  project : $ProjectPath"
Write-Host "  server  : codegraph"
Write-Host "  tool    : mcp__codegraph__codegraph_explore"
Write-Host ""
Write-Host "No restart needed - DSH hot-reloads this file within a few seconds." -ForegroundColor Cyan
Write-Host "Verify with any of:"
Write-Host "  * ask the model: 'use codegraph to show <symbol>'"
Write-Host "  * look for a node.exe running: ...codegraph.js serve --mcp"
Write-Host "  * Settings > Plugins: an entry named 'mcp-codegraph'"
Write-Host ""
Write-Host "Rollback: Copy-Item '$backup' '$patchPath' -Force" -ForegroundColor DarkGray
