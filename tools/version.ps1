<#
.SYNOPSIS
    Reads, bumps or sets the one version JustViewMD carries.

.DESCRIPTION
    project(JustViewMD VERSION X.Y) in CMakeLists.txt is the only place the
    version lives.  CMake writes it out for the resource block, for the title
    bar, for the update check and for the executable's name, so editing that
    one line keeps the tag, the file properties, the build's name and what the
    application displays in agreement.

    The version has two numbers.  Three are accepted as well, so a project that
    already carries a patch number keeps working, but JustViewMD does not use
    one: a build that carries a change bumps the minor number.

    This script is that edit, and the build script (build.bat) calls it before
    it configures.  It prints the resulting version on stdout and nothing else,
    so the caller can capture it.

.PARAMETER KeepVersion
    Keep the current version: rebuild what is there without a new number.

.PARAMETER Version
    Set the version outright, for a deliberate major or minor bump, e.g.
    -Version 2.0.  Nothing is incremented on top of it.

.EXAMPLE
    .\tools\version.ps1
    1.7

.EXAMPLE
    .\tools\version.ps1 -KeepVersion
    1.6

.EXAMPLE
    .\tools\version.ps1 -Version 2.0
    2.0
#>
[CmdletBinding()]
param(
    [switch]$KeepVersion,
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root 'CMakeLists.txt'
if (-not (Test-Path -LiteralPath $file)) {
    Write-Error "CMakeLists.txt was not found at $file"
    exit 1
}

$text = [System.IO.File]::ReadAllText($file)
$pattern = [regex]'(?m)^project\(JustViewMD VERSION (\d+)\.(\d+)(?:\.(\d+))?(.*)$'
$match = $pattern.Match($text)
if (-not $match.Success) {
    Write-Error 'CMakeLists.txt has no "project(JustViewMD VERSION X.Y" line'
    exit 1
}

$major = $match.Groups[1].Value
$minor = $match.Groups[2].Value
$hasPatch = $match.Groups[3].Success
$current = if ($hasPatch) {
    '{0}.{1}.{2}' -f $major, $minor, $match.Groups[3].Value
} else {
    '{0}.{1}' -f $major, $minor
}
$next = $current

if ($Version) {
    if ($KeepVersion) {
        Write-Error 'Use either -Version or -KeepVersion, not both'
        exit 1
    }
    if ($Version -notmatch '^\d+\.\d+(\.\d+)?$') {
        Write-Error "-Version must be two numbers like 1.2, not '$Version'"
        exit 1
    }
    $next = $Version
} elseif (-not $KeepVersion) {
    # A build that carries a change bumps the last number: the major one is a
    # deliberate decision, made with -Version.
    if ($hasPatch) {
        $next = '{0}.{1}.{2}' -f $major, $minor, ([int]$match.Groups[3].Value + 1)
    } else {
        $next = '{0}.{1}' -f $major, ([int]$minor + 1)
    }
}

if ($next -ne $current) {
    $updated = $pattern.Replace($text, {
        param($m)
        'project(JustViewMD VERSION ' + $next + $m.Groups[4].Value
    }, 1)
    # No BOM, and the rest of the file keeps the line endings it already had.
    [System.IO.File]::WriteAllText($file, $updated, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Output $next
