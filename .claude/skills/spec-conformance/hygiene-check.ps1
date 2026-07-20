<#
.SYNOPSIS
  Flag references that a reader with only the repository cannot follow — audit/finding numbering and paths into scratch directories — before committing a conformance batch.

.DESCRIPTION
  Part of the spec-conformance skill; the Windows twin of hygiene-check.py.

  Flagged by default: audit/finding numbering ("finding 7", "audit #3", "所見 12"), and paths into scratch directories ("tmp\notes.md", "scratch/plan"). Both are fine while working and useless afterwards, because the thing they point at was never committed.

  NOT flagged by default: bare issue numbers like "#123" — many projects reference their tracker that way on purpose. Enable -BanBareHashNumbers where project policy forbids them.

  Prose files (.md, .rst, .txt, .adoc) are scanned in full; source files are scanned on comment and docstring lines only, since executable code legitimately contains paths like "tmp/". Use -AllLines to scan everything.

  Exit codes: 0 clean, 1 hits found, 2 bad arguments.

.PARAMETER Config
  Path to .claude/conformance.json. Supplies hygieneRoots / hygienePatterns / scratchDirs / banBareHashNumbers unless overridden by explicit parameters.

.PARAMETER Patterns
  Extra regex patterns, ADDED to the defaults (not replacing them).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File hygiene-check.ps1 -Config .claude\conformance.json
  powershell -NoProfile -ExecutionPolicy Bypass -File hygiene-check.ps1 -Roots src,tests,doc -BanBareHashNumbers
#>
param(
  [string]$Config,
  [string[]]$Roots,
  [string[]]$Patterns,
  [string[]]$ScratchDirs,
  [switch]$BanBareHashNumbers,
  [switch]$AllLines
)

$defaultRoots = @('src', 'tests', 'test', 'lib', 'doc', 'docs')
$defaultScratch = @('tmp', 'scratch', 'notes')
$defaultPatterns = @('(?i)\bfindings?\s*#?\d', '(?i)\baudit\s*#?\d', '所見\s*#?\d', '(?i)\bitem\s*#\d')
$bareHashPattern = '(?<![A-Za-z0-9.])#\d{1,4}\b'

$cfgRoots = $null; $cfgPatterns = $null; $cfgScratch = $null; $cfgBanHash = $false
if ($Config) {
  if (-not (Test-Path $Config)) { Write-Error "Cannot read config: $Config"; exit 2 }
  try { $cfg = Get-Content -Raw -Encoding UTF8 $Config | ConvertFrom-Json } catch { Write-Error "Invalid JSON in ${Config}: $_"; exit 2 }
  $cfgRoots = $cfg.hygieneRoots
  $cfgPatterns = $cfg.hygienePatterns
  $cfgScratch = $cfg.scratchDirs
  if ($cfg.banBareHashNumbers) { $cfgBanHash = $true }
}

if ($Roots) { $useRoots = $Roots } elseif ($cfgRoots) { $useRoots = $cfgRoots } else { $useRoots = $defaultRoots }
if ($ScratchDirs) { $useScratch = $ScratchDirs } elseif ($cfgScratch) { $useScratch = $cfgScratch } else { $useScratch = $defaultScratch }
if ($Patterns) { $extraPatterns = $Patterns } elseif ($cfgPatterns) { $extraPatterns = $cfgPatterns } else { $extraPatterns = @() }

$allPatterns = @($defaultPatterns)
foreach ($d in $useScratch) { $allPatterns += ('(?<![A-Za-z0-9_.-])' + [regex]::Escape($d) + '[\\/][\w.-]') }
foreach ($p in $extraPatterns) { $allPatterns += $p }
if ($BanBareHashNumbers -or $cfgBanHash) { $allPatterns += $bareHashPattern }

$proseExts = @('.md', '.rst', '.txt', '.adoc')
$hashComment = @('.py', '.rb', '.sh', '.bash', '.zsh', '.pl', '.yaml', '.yml', '.toml', '.r', '.jl', '.ex', '.exs')
$slashComment = @('.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.cs', '.c', '.h', '.cpp', '.hpp', '.php', '.kt', '.swift', '.scala', '.dart', '.sv')
$dashComment = @('.sql', '.lua', '.hs')
$includeExts = @()
foreach ($e in ($proseExts + $hashComment + $slashComment + $dashComment)) { $includeExts += ('*' + $e) }

$sq = [string][char]39
$tripleSingle = $sq + $sq + $sq

$existingRoots = $useRoots | Where-Object { Test-Path $_ }
if (-not $existingRoots) {
  Write-Host "No roots to scan (looked for: $($useRoots -join ', '))."
  exit 0
}

$hits = @()
foreach ($root in $existingRoots) {
  $files = Get-ChildItem -Path $root -Recurse -File -Include $includeExts -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -notmatch '[\\/](node_modules|__pycache__|\.git|\.venv|venv|dist|build|target|vendor|\.mypy_cache|\.pytest_cache)[\\/]' }
  foreach ($f in $files) {
    $ext = $f.Extension.ToLower()
    $isProse = $proseExts -contains $ext
    $marker = $null
    if ($hashComment -contains $ext) { $marker = '#' }
    elseif ($slashComment -contains $ext) { $marker = '//' }
    elseif ($dashComment -contains $ext) { $marker = '--' }

    $n = 0
    $inBlock = $false
    $blockEnd = $null
    foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
      $n++
      # Only the comment/docstring part of a line is matched, so a trailing comment does not drag
      # the executable part into the scan (otherwise `TMP_ROOT = "tmp/cache"  # note` reports the code).
      $segment = $null
      if ($isProse -or $AllLines) {
        $segment = $line
      } elseif ($inBlock) {
        $segment = $line
        if ($line.Contains($blockEnd)) { $inBlock = $false }
      } else {
        $trimmed = $line.Trim()
        $i = -1
        if ($ext -eq '.py') {
          $iD = $line.IndexOf('"""'); $iS = $line.IndexOf($tripleSingle)
          if ($iD -ge 0 -and $iS -ge 0) { $i = [Math]::Min($iD, $iS) } elseif ($iD -ge 0) { $i = $iD } else { $i = $iS }
          if ($i -ge 0) {
            $q = $line.Substring($i, 3)
            if (([regex]::Matches($line, [regex]::Escape($q))).Count -eq 1) { $inBlock = $true; $blockEnd = $q }
            $segment = $line.Substring($i)
          }
        } else {
          $i = $line.IndexOf('/*')
          if ($i -ge 0) {
            if (-not $line.Substring($i).Contains('*/')) { $inBlock = $true; $blockEnd = '*/' }
            $segment = $line.Substring($i)
          } elseif ($trimmed.StartsWith('*')) {
            $segment = $line
          }
        }
        if ($null -eq $segment -and $marker) {
          $j = $line.IndexOf($marker)
          if ($j -ge 0) { $segment = $line.Substring($j) }
        }
      }
      if ($null -ne $segment) {
        foreach ($p in $allPatterns) {
          if ($segment -match $p) {
            $rel = Resolve-Path -Relative $f.FullName
            $hits += [pscustomobject]@{ Path = $rel; Line = $n; Text = $line.Trim() }
            break
          }
        }
      }
    }
  }
}

if ($hits.Count -eq 0) {
  Write-Host "OK: no unfollowable references found in $($existingRoots -join ', ')."
  exit 0
}

Write-Host "FOUND $($hits.Count) unfollowable reference(s) -- rewrite each as prose that states the reason itself:"
Write-Host ""
foreach ($h in $hits) {
  $t = $h.Text
  if ($t.Length -gt 160) { $t = $t.Substring(0, 160) + '...' }
  Write-Host ("{0}:{1}: {2}" -f $h.Path, $h.Line, $t)
}
exit 1
