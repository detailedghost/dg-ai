# Install the compiled dg-skills CLI for Windows into %USERPROFILE%\.dg\bin.
#
#   irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
#
# CLI-only (skip the extension, dg-daemon and dg-agent): set $env:DG_CLI_ONLY = "1" first.
# Agent-only (install dg-agent too, for a non-Claude agent that only needs phone; still
# skips the extension and dg-daemon): set $env:DG_AGENT_ONLY = "1" first.
# Skills-only (instruction files plus the checksum-verified dg-skills CLI; no daemon, agent or extension, no skill execution): set $env:DG_SKILLS_ONLY = "1" first.
#
# Pin a version instead of the newest release: set $env:DG_VERSION = "<x.y.z>" first
# (piped `irm | iex` cannot take parameters), or pass -Version <x.y.z> when running a
# saved copy of this file directly. A leading v or skills-v prefix is accepted. With
# DG_SKILLS_ONLY this script installs that exact skills-v<x.y.z> binary directly. Every
# other mode downloads the newest skills-v* binary to a temp file instead and runs its
# `install --version <x.y.z>` (deleted afterward either way), because that is the
# binary that knows how to resolve, download and verify a pinned release — the newest
# release may predate --version support. That install checks every release the mode
# needs, then downloads and verifies every artifact (with checksums) into staging, and
# only then replaces anything, including dg-skills itself and its version stamp. Unset:
# install the newest of each, warning and skipping one that is missing.
#
# Idempotent: re-running overwrites the binary with the newest skills-v* release
# (or the pinned one, with -Version/DG_VERSION).
# Skills-only copies plugins/dg/skills into $env:DG_SKILLS_DEST
# (default: $env:DG_HOME\skills or ~/.dg/skills).
#
# When the skills-v* release publishes SHA256SUMS (GNU sha256sum lines), the
# download is verified before it is installed. Releases without that asset
# still install. The skills release workflow writes the file beside the binaries.
param(
	[string]$Version
)
$ErrorActionPreference = "Stop"

# Copy skill directories as data, matching @dg/common filesToInstall.
# A skill is an immediate child directory that contains SKILL.md.
# Symlinks are refused. Files are copied and never invoked.
function Copy-DgSkillTree {
	param($Source, $Destination)
	if (-not (Test-Path -LiteralPath $Source)) {
		throw "dg-skills: no skills directory at $Source"
	}
	$links = Get-ChildItem -LiteralPath $Source -Recurse -Force | Where-Object {
		$_.Attributes -band [IO.FileAttributes]::ReparsePoint
	}
	if ($links) { throw "dg-skills: refusing to copy a symlink from $Source" }
	New-Item -ItemType Directory -Force -Path $Destination | Out-Null
	$manifest = @()
	$found = $false
	foreach ($skill in Get-ChildItem -LiteralPath $Source -Directory) {
		$manifestPath = Join-Path $skill.FullName "SKILL.md"
		if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
		$found = $true
		$target = Join-Path $Destination $skill.Name
		if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
		New-Item -ItemType Directory -Force -Path $target | Out-Null
		foreach ($file in Get-ChildItem -LiteralPath $skill.FullName -Recurse -File -Force) {
			$rel = $file.FullName.Substring($skill.FullName.Length).TrimStart('\', '/')
			if ($rel -match '(^|[\\/])\.\.([\\/]|$)') { throw "dg-skills: refusing $rel" }
			$out = Join-Path $target $rel
			New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
			Copy-Item -LiteralPath $file.FullName -Destination $out -Force
			$manifest += ($skill.Name + "/" + ($rel -replace '\\', '/'))
		}
	}
	if (-not $found) { throw "dg-skills: $Source has no skill directories" }
	$manifest | Sort-Object | ForEach-Object { Write-Host $_ }
	Write-Host "Installed $($manifest.Count) skill files at $Destination."
	Write-Host "Skills-only install: no skill content was executed. Fetching only the dg-skills CLI (no daemon, agent or extension)."
}

$repo = "detailedghost/dg-ai"
$headers = @{ "User-Agent" = "dg-ai" }
$script:rel = $null

$script:pinnedVersion = $null
$rawVersion = if ($Version) { $Version } elseif ($env:DG_VERSION) { $env:DG_VERSION } else { $null }
if ($rawVersion) {
	if ($rawVersion -like "skills-v*") { $script:pinnedVersion = $rawVersion.Substring(8) }
	elseif ($rawVersion -like "v*") { $script:pinnedVersion = $rawVersion.Substring(1) }
	else { $script:pinnedVersion = $rawVersion }
}

function Test-DgPrefixedVersion([string]$Version) {
	try { return ([version]$Version) -le ([version]"1.21.1") } catch { return $false }
}

function Resolve-DgRelease {
	if ($script:rel) { return $script:rel }
	$perPage = 100
	$pageCap = 10
	$scanned = 0
	$want = if ($env:DG_SKILLS_ONLY -eq "1" -and $script:pinnedVersion) {
		if (Test-DgPrefixedVersion $script:pinnedVersion) { "skills-v$($script:pinnedVersion)" } else { "v$($script:pinnedVersion)" }
	} else { $null }
	for ($page = 1; $page -le $pageCap; $page++) {
		$batch = @(Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases?per_page=$perPage&page=$page")
		$scanned += $batch.Count
		$script:rel = if ($want) {
			$batch | Where-Object { $_.tag_name -eq $want -and -not $_.draft } | Select-Object -First 1
		} else {
			$batch | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+$' -and -not $_.draft } | Sort-Object { [version]$_.tag_name.Substring(1) } -Descending | Select-Object -First 1
		}
		if ($script:rel -or $batch.Count -lt $perPage) { break }
	}
	if (-not $script:rel) {
		if ($want) { throw "dg-skills: no release named $want found in the $scanned releases scanned" }
		throw "dg-skills: no vX.Y.Z release found in the $scanned releases scanned"
	}
	return $script:rel
}

function Get-DgSkillsSource {
	if ($env:DG_SKILLS_SOURCE) { return $env:DG_SKILLS_SOURCE }
	if ($PSScriptRoot) {
		$local = Join-Path $PSScriptRoot "..\..\plugins\dg\skills"
		if (Test-Path -LiteralPath (Join-Path $local "browser\SKILL.md")) {
			return (Resolve-Path -LiteralPath $local).Path
		}
	}
	$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dg-ai-skills-" + [guid]::NewGuid())
	$script:skillsTmp = $tmp
	New-Item -ItemType Directory -Force -Path $tmp | Out-Null
	$archive = Join-Path $tmp "dg-ai.zip"
	$tag = (Resolve-DgRelease).tag_name
	Invoke-WebRequest -Headers $headers -Uri "https://github.com/$repo/archive/refs/tags/$tag.zip" -OutFile $archive
	Expand-Archive -Path $archive -DestinationPath $tmp -Force
	return (Join-Path $tmp "dg-ai-$tag\plugins\dg\skills")
}

if ($env:DG_SKILLS_ONLY -eq "1" -and $env:DG_CLI_ONLY -eq "1") {
	throw "dg-skills: set only one of DG_SKILLS_ONLY and DG_CLI_ONLY"
}
if ($env:DG_SKILLS_ONLY -eq "1" -and $env:DG_AGENT_ONLY -eq "1") {
	throw "dg-skills: set only one of DG_SKILLS_ONLY and DG_AGENT_ONLY"
}
if ($env:DG_CLI_ONLY -eq "1" -and $env:DG_AGENT_ONLY -eq "1") {
	throw "dg-skills: set only one of DG_CLI_ONLY and DG_AGENT_ONLY"
}

if ($env:DG_SKILLS_ONLY -eq "1") {
	$skillsDest = if ($env:DG_SKILLS_DEST) { $env:DG_SKILLS_DEST }
		elseif ($env:DG_HOME) { Join-Path $env:DG_HOME "skills" }
		else { Join-Path $env:USERPROFILE ".dg\skills" }
	try {
		Copy-DgSkillTree -Source (Get-DgSkillsSource) -Destination $skillsDest
	} finally {
		if ($script:skillsTmp) { Remove-Item -Recurse -Force $script:skillsTmp -ErrorAction SilentlyContinue }
	}
	if ($env:DG_SKILLS_NO_CLI -eq "1") {
		Write-Host "Skipped the dg-skills CLI (DG_SKILLS_NO_CLI=1): offline copy only."
		exit 0
	}
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$asset = "dg-skills-windows-$arch.exe"
$dgHome = if ($env:DG_HOME) { $env:DG_HOME } else { Join-Path $env:USERPROFILE ".dg" }
$binDir = Join-Path $dgHome "bin"
$dest = Join-Path $binDir "dg-skills.exe"

$rel = Resolve-DgRelease

$url = $rel.assets | Where-Object { $_.name -eq $asset } | Select-Object -ExpandProperty browser_download_url -First 1

if (-not $url) { throw "dg-skills: no $asset asset in $($rel.tag_name)" }

$delegate = $env:DG_SKILLS_ONLY -ne "1" -and $script:pinnedVersion
$installer = if ($delegate) {
	Join-Path ([System.IO.Path]::GetTempPath()) ("dg-skills-installer-" + [guid]::NewGuid() + ".exe")
} else {
	Join-Path $binDir (".dg-skills-installer-" + [guid]::NewGuid() + ".exe")
}
$exitCode = 0

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
try {
	Invoke-WebRequest -Headers $headers -Uri $url -OutFile $installer

	$sums = $rel.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
	if ($sums) {
		$sumsPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dg-skills-SHA256SUMS-" + [guid]::NewGuid())
		try {
			Invoke-WebRequest -Headers $headers -Uri $sums.browser_download_url -OutFile $sumsPath
			$expected = $null
			foreach ($line in Get-Content $sumsPath) {
				if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$' -and $Matches[2] -eq $asset) {
					$expected = $Matches[1].ToLowerInvariant()
					break
				}
			}
			if (-not $expected) {
				Remove-Item $installer -Force
				throw "dg-skills: SHA256SUMS in $($rel.tag_name) has no entry for $asset"
			}
			$actual = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash.ToLowerInvariant()
			if ($actual -ne $expected) {
				Remove-Item $installer -Force
				throw "dg-skills: checksum mismatch for $asset in $($rel.tag_name)"
			}
		} finally {
			Remove-Item $sumsPath -Force -ErrorAction SilentlyContinue
		}
	}

	if (-not $delegate) {
		$lockPath = Join-Path (Resolve-Path -LiteralPath $binDir).ProviderPath ".dg-skills-swap.lock"
		$deadline = (Get-Date).AddMinutes(2)
		$swapLock = $null
		while (-not $swapLock) {
			try {
				$swapLock = [System.IO.File]::Open($lockPath, "OpenOrCreate", "ReadWrite", "None")
			} catch [System.IO.IOException] {
				if ((Get-Date) -gt $deadline) { throw "dg-skills: another bootstrap is still replacing $dest" }
				Start-Sleep -Milliseconds 250
			}
		}
		try {
			$old = $null
			if (Test-Path -LiteralPath $dest) {
				$old = "$dest.old-" + [guid]::NewGuid()
				Move-Item -LiteralPath $dest -Destination $old
			}
			try {
				Move-Item -LiteralPath $installer -Destination $dest
			} catch {
				if ($old -and -not (Test-Path -LiteralPath $dest)) {
					Move-Item -LiteralPath $old -Destination $dest
				}
				throw
			}
			$installer = $dest
			$oldPrefix = (Split-Path -Leaf $dest) + ".old-"
			Get-ChildItem -LiteralPath $binDir -File |
				Where-Object { $_.Name.StartsWith($oldPrefix) } |
				ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
			# Stamp the installed version so `dg-skills install` won't re-download the binary.
			Set-Content -Path (Join-Path $binDir ".dg-skills.version") -Value ($rel.tag_name -replace '^(skills-)?v', '')
		} finally {
			$swapLock.Dispose()
		}
		Write-Host "dg-skills installed at $dest"
	}

	if ($env:PATH -notlike "*$binDir*") {
		Write-Host "Add to PATH:  `$env:PATH = `"$binDir;`$env:PATH`""
	}

	function Convert-DgInstallLine {
		param([string]$Line)
		if ($Line -match '^dg-skills already current \(v(.+)\)\.$') {
			return "dg-skills verified (v$($Matches[1]))."
		}
		return $Line
	}

	# Skills-only stops at the CLI: no `dg-skills install`, so no daemon, agent or extension.
	if ($env:DG_SKILLS_ONLY -eq "1") { exit 0 }

	$versionArgs = if ($script:pinnedVersion) { @("--version", $script:pinnedVersion) } else { @() }
	$env:DG_SKILLS_BOOTSTRAP = "1"
	if ($env:DG_CLI_ONLY -eq "1") {
		$installOutput = & $installer install --cli-only @versionArgs 2>&1
	} elseif ($env:DG_AGENT_ONLY -eq "1") {
		$installOutput = & $installer install --agent-only @versionArgs 2>&1
	} else {
		# Set up the browser extension too, so one command installs everything.
		Write-Host "Setting up the dg-ai-extension…"
		$installOutput = & $installer install @versionArgs 2>&1
	}
	$exitCode = $LASTEXITCODE
	$installOutput | ForEach-Object { Write-Host (Convert-DgInstallLine "$_") }
} finally {
	if ($installer -ne $dest) { Remove-Item $installer -Force -ErrorAction SilentlyContinue }
}
if ($exitCode -ne 0) { exit $exitCode }

# Optional Codex skill installation. Set DG_INSTALL_CODEX=1 to copy the
# repository's skills into CODEX_HOME (default: $HOME\.codex\skills).
if ($env:DG_INSTALL_CODEX -eq "1") {
	$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
	$codexTag = if (-not $script:pinnedVersion) { $rel.tag_name } elseif (Test-DgPrefixedVersion $script:pinnedVersion) { "skills-v$($script:pinnedVersion)" } else { "v$($script:pinnedVersion)" }
	$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dg-ai-" + [guid]::NewGuid())
	$archive = Join-Path $tmpDir "dg-ai.zip"
	New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
	try {
		Invoke-WebRequest -Headers $headers -Uri "https://github.com/$repo/archive/refs/tags/$codexTag.zip" -OutFile $archive
		Expand-Archive -Path $archive -DestinationPath $tmpDir -Force
		$skillsDir = Join-Path $codexRoot "skills"
		New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
		foreach ($skill in Get-ChildItem -Directory (Join-Path $tmpDir "dg-ai-$codexTag\plugins\dg\skills")) {
			if (($env:DG_CLI_ONLY -eq "1" -or $env:DG_AGENT_ONLY -eq "1") -and (Select-String -Path (Join-Path $skill.FullName "SKILL.md") -Pattern "^requires:.*extension" -Quiet)) { continue }
			Copy-Item -Recurse -Force $skill.FullName $skillsDir
		}
	} finally {
		Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
	}
	Write-Host "Codex skills installed in $skillsDir"
}
