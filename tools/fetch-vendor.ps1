#Requires -Version 5.1
<#
.SYNOPSIS
    Downloads the third-party front-end libraries that JustViewMD ships with.

.DESCRIPTION
    JustViewMD must render Markdown, math, diagrams and highlighted code with
    zero network access at run time.  Everything it needs is therefore vendored
    into  assets/vendor  and committed with the project.

    This script is a maintenance tool only: run it when you want to refresh the
    vendored libraries.  A normal build never needs it.

    Versions are pinned below so that a given commit always produces the same
    assets.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\fetch-vendor.ps1
#>
[CmdletBinding()]
param(
    # Project root (defaults to the parent of this script's folder).
    [string]$Root
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($Root)) {
    # $PSScriptRoot is not usable in parameter defaults on Windows PowerShell 5.1.
    if ($PSScriptRoot) {
        $scriptDirectory = $PSScriptRoot
    } elseif ($PSCommandPath) {
        $scriptDirectory = Split-Path -Parent $PSCommandPath
    } else {
        $scriptDirectory = Split-Path -Parent (Resolve-Path $MyInvocation.MyCommand.Path)
    }
    $Root = Split-Path -Parent $scriptDirectory
}

# --------------------------------------------------------------------------
# Pinned versions
# --------------------------------------------------------------------------
$MarkedVersion  = '18.1.1'   # UMD build, global `marked`
$KatexVersion   = '0.19.0'   # katex.min.js / katex.min.css / fonts
$PrismVersion   = '1.30.0'   # component files, concatenated into one bundle
$MermaidVersion = '10.9.8'   # last UMD (classic <script>) release line

# Prism languages to bundle, in dependency-safe order.
$PrismLangs = @(
    'markup', 'css', 'clike', 'javascript', 'typescript', 'jsx', 'tsx',
    'json', 'yaml', 'toml', 'ini', 'bash', 'powershell', 'batch',
    'python', 'c', 'cpp', 'csharp', 'java', 'kotlin', 'go', 'rust',
    'ruby',
    # markup-templating is not a language: php (and the template languages) call
    # into it from their tokenizer hooks, so it has to come first.
    'markup-templating', 'php',
    'sql', 'http', 'diff', 'docker', 'nginx', 'markdown'
)

$vendor = Join-Path $Root 'assets\vendor'
$tmp    = Join-Path $env:TEMP 'jvmd-vendor'
$null   = New-Item -ItemType Directory -Force -Path $vendor, $tmp

function Write-Step([string]$Text) { Write-Host "  $Text" }

function Get-RemoteFile([string]$Url, [string]$Destination) {
    Write-Step "GET  $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 600
    if (-not (Test-Path $Destination) -or (Get-Item $Destination).Length -eq 0) {
        throw "Download produced no data: $Url"
    }
}

function Expand-Package([string]$Name, [string]$Version) {
    $tgz = Join-Path $tmp "$Name-$Version.tgz"
    $dir = Join-Path $tmp "$Name-$Version"
    if (-not (Test-Path $tgz)) {
        Get-RemoteFile "https://registry.npmjs.org/$Name/-/$Name-$Version.tgz" $tgz
    }
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    $null = New-Item -ItemType Directory -Force -Path $dir
    & tar -xzf $tgz -C $dir
    if ($LASTEXITCODE -ne 0) { throw "tar failed for $Name-$Version.tgz" }
    Join-Path $dir 'package'
}

# --------------------------------------------------------------------------
# 1. marked  (CommonMark + GFM parser)
# --------------------------------------------------------------------------
Write-Host 'marked ...'
$markedPkg = Expand-Package 'marked' $MarkedVersion
$null = New-Item -ItemType Directory -Force -Path $vendor
Copy-Item (Join-Path $markedPkg 'lib\marked.umd.js') (Join-Path $vendor 'marked.js') -Force

# --------------------------------------------------------------------------
# 2. KaTeX  (math typesetting: script, stylesheet, woff2 fonts)
# --------------------------------------------------------------------------
Write-Host 'katex ...'
$katexPkg = Expand-Package 'katex' $KatexVersion
$katexOut = Join-Path $vendor 'katex'
$null = New-Item -ItemType Directory -Force -Path $katexOut, (Join-Path $katexOut 'fonts')
Copy-Item (Join-Path $katexPkg 'dist\katex.min.js')  $katexOut -Force
Copy-Item (Join-Path $katexPkg 'dist\katex.min.css') $katexOut -Force
# Only the woff2 fonts are kept: WebView2 (Chromium) always prefers them.
Copy-Item (Join-Path $katexPkg 'dist\fonts\*.woff2') (Join-Path $katexOut 'fonts') -Force

# --------------------------------------------------------------------------
# 3. Prism  (syntax highlighting: one concatenated bundle + both themes)
# --------------------------------------------------------------------------
Write-Host 'prism ...'
$prismPkg = Expand-Package 'prismjs' $PrismVersion
$prismOut = Join-Path $vendor 'prism'
$null = New-Item -ItemType Directory -Force -Path $prismOut

$bundle = New-Object System.Collections.Generic.List[string]
$bundle.Add("/* Prism.js $PrismVersion - https://prismjs.com - MIT license - bundled for offline use. */")
$coreFile = Join-Path $prismPkg 'components\prism-core.min.js'
if (-not (Test-Path $coreFile)) { throw "prism-core.min.js not found in prismjs $PrismVersion" }
$bundle.Add([IO.File]::ReadAllText($coreFile))
foreach ($lang in $PrismLangs) {
    $file = Join-Path $prismPkg "components\prism-$lang.min.js"
    if (-not (Test-Path $file)) { throw "Prism component missing: prism-$lang.min.js" }
    $bundle.Add("/* language: $lang */")
    $bundle.Add([IO.File]::ReadAllText($file))
}
# Each Prism component is a self-contained IIFE; a ';' between them keeps
# concatenation safe regardless of trailing newlines.
[IO.File]::WriteAllText((Join-Path $prismOut 'prism.js'), ($bundle -join "`n;`n"), (New-Object Text.UTF8Encoding($false)))
Copy-Item (Join-Path $prismPkg 'themes\prism-tomorrow.min.css') (Join-Path $prismOut 'prism.css') -Force
# Light counterpart, switched in when the light theme is selected.
Copy-Item (Join-Path $prismPkg 'themes\prism.min.css') (Join-Path $prismOut 'prism-light.css') -Force

# --------------------------------------------------------------------------
# 4. Mermaid  (diagram rendering, classic UMD build exposing window.mermaid)
# --------------------------------------------------------------------------
Write-Host 'mermaid ...'
$mermaidPkg = Expand-Package 'mermaid' $MermaidVersion
$mermaidOut = Join-Path $vendor 'mermaid'
$null = New-Item -ItemType Directory -Force -Path $mermaidOut
Copy-Item (Join-Path $mermaidPkg 'dist\mermaid.min.js') $mermaidOut -Force

# --------------------------------------------------------------------------
# 5. License texts (kept next to the vendored code)
# --------------------------------------------------------------------------
Write-Host 'licenses ...'
$licenseOut = Join-Path $vendor 'licenses'
$null = New-Item -ItemType Directory -Force -Path $licenseOut
foreach ($package in @(
        @{ Name = 'marked';  Directory = $markedPkg;  LicenseUrl = $null },
        @{ Name = 'katex';   Directory = $katexPkg;   LicenseUrl = $null },
        @{ Name = 'prismjs'; Directory = $prismPkg;   LicenseUrl = $null },
        # The mermaid npm package does not carry a license file, so it is taken
        # from the repository at the very tag the package was published from.
        @{ Name = 'mermaid'; Directory = $mermaidPkg
           LicenseUrl = "https://raw.githubusercontent.com/mermaid-js/mermaid/v$MermaidVersion/LICENSE" })) {
    $copied = $false
    foreach ($candidate in @('LICENSE', 'LICENSE.md', 'LICENSE.txt')) {
        $candidatePath = Join-Path $package.Directory $candidate
        if (Test-Path $candidatePath) {
            Copy-Item $candidatePath (Join-Path $licenseOut "$($package.Name).txt") -Force
            $copied = $true
            break
        }
    }
    if (-not $copied -and $package.LicenseUrl) {
        Get-RemoteFile $package.LicenseUrl (Join-Path $licenseOut "$($package.Name).txt")
    }
}

# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------
Write-Host ''
Write-Host 'Vendored files:'
Get-ChildItem $vendor -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
        $rel = $_.FullName.Substring($vendor.Length + 1)
        '{0,-46} {1,10:N0} bytes' -f $rel, $_.Length
    }
Write-Host ''
Write-Host ("Total: {0:N2} MB" -f ((Get-ChildItem $vendor -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))
