# Install the dg runtime and bundle for Windows into %LOCALAPPDATA%\dg, then run `dg-skills install`.
#
#   irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
#
# Piped `irm | iex` cannot take switches. To pass one, run the script as a script block:
#
#   & ([scriptblock]::Create((irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1))) -ChatOnly
#
# -CliOnly     skip the extension.
# -AgentOnly   install for a non-Claude agent that only needs phone.
# -SkillsOnly  copy the skill files, then the runtime and bundle; no extension and no `dg-skills install`.
#              Add -NoCli for an offline copy of the skill files that downloads no release, and
#              -Dest <dir> to choose where they go.
# -ChatOnly     download only the chat skills for Claude chat: the checksum-verified
#              dg-chat-skills-<x.y.z>.zip unpacked into .\dg-chat-skills (or -Dest <dir>), one upload-ready
#              ZIP per skill. No runtime, no bundle, no launchers, no extension, and nothing it unpacks is run.
# -Codex       also copy the skills into $CODEX_HOME\skills.
# -Version <x.y.z>  install that release instead of the newest. A leading v is accepted.
#
# Older scripts may still set DG_CLI_ONLY, DG_AGENT_ONLY, DG_SKILLS_ONLY, DG_SKILLS_NO_CLI, DG_SKILLS_DEST,
# DG_INSTALL_CODEX or DG_VERSION; those keep working, and a switch always wins.
#
# Layout: runtime\bun-v<bun>, lib\<release>, runtime\current and lib\current junctions, and
# bin\dg-skills.cmd, bin\dg-agent.cmd, bin\dg-daemon.cmd shims. Every download is verified
# against SHA256SUMS or runtime.json before anything is installed. Re-running upgrades in place.
param(
	[string]$Version,
	[switch]$CliOnly,
	[switch]$AgentOnly,
	[switch]$SkillsOnly,
	[switch]$NoCli,
	[switch]$ChatOnly,
	[switch]$Codex,
	[string]$Dest
)
$ErrorActionPreference = "Stop"

$wantCliOnly = $CliOnly.IsPresent -or $env:DG_CLI_ONLY -eq "1"
$wantAgentOnly = $AgentOnly.IsPresent -or $env:DG_AGENT_ONLY -eq "1"
$wantSkillsOnly = $SkillsOnly.IsPresent -or $env:DG_SKILLS_ONLY -eq "1"
$wantNoCli = $NoCli.IsPresent -or $env:DG_SKILLS_NO_CLI -eq "1"
$wantCodex = $Codex.IsPresent -or $env:DG_INSTALL_CODEX -eq "1"
$wantChatOnly = $ChatOnly.IsPresent

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
	$retiredHashes = @{
		"teach" = @("b32cdde3ab7f7239d157dd2225c984e48c02aa981cb962b42cdda5cdd1c4dc68", "bb06ec5c6763216f76a7af5fbbea839476008747740ded023d285a5afddbd3c9", "f5c44555744159f345cfdd1ab1eede4977f06cf31b911edffc48e35747b313a9", "d173128190d9450759d3ca5a261987448e176665fabb9cd7a0ffba4d4f006020")
		"wait-what" = @("3ff07fa007759e417d95c4885ed333a84119cc0d621f7e3d805ca46b6ffb3dd6", "6f40fe8148898ee8cb306b8fec3f8f674ee346f5ef54bf9f2d2790e43e1e1f4a", "9b0cee4706ad7eb61490d3cb997b1dad7cfebd2dc974e4735b5a2fb65a1bcb3e", "f923f0a108954acb787d4b9d331bc44525ab70721df0e00e719284007a773bd0")
	}
	foreach ($retired in @("phone-friend", "teach", "wait-what")) {
		$retiredPath = Join-Path $Destination $retired
		if (-not (Test-Path -LiteralPath $retiredPath)) { continue }
		if ($retiredHashes.ContainsKey($retired)) {
			$retiredSkill = Join-Path $retiredPath "SKILL.md"
			if (-not (Test-Path -LiteralPath $retiredSkill -PathType Leaf)) { continue }
			try {
				$retiredHash = (Get-FileHash -LiteralPath $retiredSkill -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
			} catch {
				continue
			}
			if ($retiredHashes[$retired] -notcontains $retiredHash) { continue }
		}
		Remove-Item -LiteralPath $retiredPath -Recurse -Force
	}
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
	Write-Host "Skills-only install: no skill content was executed."
}

$repo = "detailedghost/dg-ai"
$headers = @{ "User-Agent" = "dg-ai" }
$script:rel = $null

$script:pinnedVersion = $null
$rawVersion = if ($Version) { $Version } elseif ($env:DG_VERSION) { $env:DG_VERSION } else { $null }
if ($rawVersion) {
	if ($rawVersion -like "v*") { $script:pinnedVersion = $rawVersion.Substring(1) }
	else { $script:pinnedVersion = $rawVersion }
}

function Resolve-DgRelease {
	if ($script:rel) { return $script:rel }
	$perPage = 100
	$pageCap = 10
	$scanned = 0
	$want = if ($script:pinnedVersion) { "v$($script:pinnedVersion)" } else { $null }
	$candidates = @()
	for ($page = 1; $page -le $pageCap; $page++) {
		$batch = @(Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases?per_page=$perPage&page=$page")
		$scanned += $batch.Count
		if ($want) {
			$script:rel = $batch | Where-Object { $_.tag_name -eq $want -and -not $_.draft } | Select-Object -First 1
			if ($script:rel) { break }
		} else {
			$candidates += @($batch | Where-Object { $_.tag_name -match '^v\d+\.\d+\.\d+$' -and -not $_.draft })
		}
		if ($batch.Count -lt $perPage) { break }
	}
	if (-not $want) {
		$script:rel = $candidates | Sort-Object { [version]$_.tag_name.Substring(1) } -Descending | Select-Object -First 1
	}
	if (-not $script:rel) {
		if ($want) { throw "dg-skills: no release named $want found in the $scanned releases scanned" }
		throw "dg-skills: no vX.Y.Z release found in the $scanned releases scanned"
	}
	return $script:rel
}

function Expand-DgSourceArchive {
	param([string]$Archive, [string]$Destination)
	Expand-Archive -Path $Archive -DestinationPath $Destination -Force
	$roots = @(Get-ChildItem -LiteralPath $Destination -Directory)
	if ($roots.Count -ne 1) { throw "dg-skills: expected one directory in the source archive, found $($roots.Count)" }
	return $roots[0].FullName
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
	$sourceRoot = Expand-DgSourceArchive -Archive $archive -Destination (Join-Path $tmp "source")
	return (Join-Path $sourceRoot "plugins\dg\skills")
}

if ($wantSkillsOnly -and $wantCliOnly) {
	throw "dg-skills: pass only one of -SkillsOnly and -CliOnly"
}
if ($wantSkillsOnly -and $wantAgentOnly) {
	throw "dg-skills: pass only one of -SkillsOnly and -AgentOnly"
}
if ($wantCliOnly -and $wantAgentOnly) {
	throw "dg-skills: pass only one of -CliOnly and -AgentOnly"
}
if ($wantChatOnly) {
	foreach ($other in @(@($wantCliOnly, "-CliOnly"), @($wantSkillsOnly, "-SkillsOnly"), @($wantAgentOnly, "-AgentOnly"), @($wantCodex, "-Codex"), @($wantNoCli, "-NoCli"))) {
		if ($other[0]) { throw "dg-skills: -ChatOnly installs nothing but the chat skills; drop $($other[1])" }
	}
}

if ($env:DG_HOME) {
	$dgRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:DG_HOME)
	$dgHome = Join-Path $dgRoot "data"
	$binDir = Join-Path $dgRoot "bin"
} else {
	$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
	$dgHome = Join-Path $localAppData "dg"
	$binDir = Join-Path $dgHome "bin"
}

if ($wantSkillsOnly) {
	$skillsDest = if ($Dest) { $Dest } elseif ($env:DG_SKILLS_DEST) { $env:DG_SKILLS_DEST } else { Join-Path $dgHome "skills" }
	try {
		Copy-DgSkillTree -Source (Get-DgSkillsSource) -Destination $skillsDest
	} finally {
		if ($script:skillsTmp) { Remove-Item -Recurse -Force $script:skillsTmp -ErrorAction SilentlyContinue }
	}
	if ($wantNoCli) {
		Write-Host "Skipped the dg-skills CLI (-NoCli): offline copy only."
		exit 0
	}
}

function Get-DgSha256([string]$Path) {
	return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Assert-DgSha256 {
	param([string]$Path, [string]$Name, [string]$Expected)
	if (-not $Expected) { throw "dg-skills: no checksum for $Name" }
	if ((Get-DgSha256 $Path) -ne $Expected.ToLowerInvariant()) {
		throw "dg-skills: checksum mismatch for $Name"
	}
}

function Get-DgSumsEntry {
	param([string]$SumsPath, [string]$Name)
	foreach ($line in Get-Content $SumsPath) {
		if ($line -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$' -and $Matches[2] -eq $Name) {
			return $Matches[1].ToLowerInvariant()
		}
	}
	return $null
}

function Save-DgAsset {
	param($Release, [string]$Name, [string]$Destination)
	$url = $Release.assets | Where-Object { $_.name -eq $Name } | Select-Object -ExpandProperty browser_download_url -First 1
	if (-not $url) { throw "dg-skills: no $Name asset in $($Release.tag_name)" }
	Invoke-WebRequest -Headers $headers -Uri $url -OutFile $Destination
}

function Set-DgJunction {
	param([string]$Link, [string]$Target)
	$staged = "$Link.$PID.tmp"
	if (Test-Path -LiteralPath $staged) { [System.IO.Directory]::Delete($staged) }
	New-Item -ItemType Junction -Path $staged -Target $Target | Out-Null
	if (Test-Path -LiteralPath $Link) { [System.IO.Directory]::Delete($Link) }
	Rename-Item -LiteralPath $staged -NewName (Split-Path -Leaf $Link)
}

function Test-DgAvx2 {
	Add-Type -Namespace Dg -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);'
	return [Dg.Cpu]::IsProcessorFeaturePresent(40)
}

# The chat skills are data for a chat upload: ZIPs and a Markdown guide. They are verified,
# unpacked into one folder, and never opened or run.
if ($wantChatOnly) {
	$chatDest = if ($Dest) { $Dest } else { Join-Path (Get-Location).Path "dg-chat-skills" }
	$rel = Resolve-DgRelease
	$tag = $rel.tag_name
	$asset = "dg-chat-skills-$($tag.Substring(1)).zip"
	$work = Join-Path ([System.IO.Path]::GetTempPath()) ("dg-chat-skills-" + [guid]::NewGuid())
	New-Item -ItemType Directory -Force -Path $work | Out-Null
	try {
		$sumsPath = Join-Path $work "SHA256SUMS"
		Save-DgAsset $rel "SHA256SUMS" $sumsPath
		$expected = Get-DgSumsEntry $sumsPath $asset
		if (-not $expected) { throw "dg-skills: SHA256SUMS in $tag has no entry for $asset" }
		Write-Host "Downloading $asset..."
		$zipPath = Join-Path $work $asset
		Save-DgAsset $rel $asset $zipPath
		Assert-DgSha256 $zipPath $asset $expected
		Add-Type -AssemblyName System.IO.Compression.FileSystem
		$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
		try { $entries = @($archive.Entries | ForEach-Object { $_.FullName }) } finally { $archive.Dispose() }
		if ($entries.Count -eq 0) { throw "dg-skills: $asset is empty" }
		foreach ($entry in $entries) {
			if ($entry -ne "UPLOAD.md" -and $entry -notmatch '^dg-[a-z0-9-]+\.zip$') { throw "dg-skills: refusing $entry in $asset" }
		}
		New-Item -ItemType Directory -Force -Path $chatDest | Out-Null
		Expand-Archive -Path $zipPath -DestinationPath $chatDest -Force
		Write-Host "Chat skills $($tag.Substring(1)) are in ${chatDest}:"
		$entries | Where-Object { $_ -like "dg-*.zip" } | ForEach-Object { Write-Host "  $_" }
		Write-Host "Upload each ZIP as a skill in Claude: Customize, then Skills, then Upload a skill."
		Write-Host "Turn on code execution in Settings, under Capabilities. A Team or Enterprise owner can add them for everyone."
		Write-Host "Chat-only install: nothing else was installed and nothing was run."
	} finally {
		Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
	}
	exit 0
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$platform = "windows-$arch"
if ($platform -eq "windows-x64" -and -not (Test-DgAvx2)) { $platform = "windows-x64-baseline" }

$rel = Resolve-DgRelease
$tag = $rel.tag_name
$releaseVersion = $tag.Substring(1)
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("dg-bootstrap-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null
$exitCode = 0

try {
	$sumsPath = Join-Path $work "SHA256SUMS"
	$runtimePath = Join-Path $work "runtime.json"
	Save-DgAsset $rel "SHA256SUMS" $sumsPath
	Save-DgAsset $rel "runtime.json" $runtimePath
	Assert-DgSha256 $runtimePath "runtime.json" (Get-DgSumsEntry $sumsPath "runtime.json")

	$runtime = Get-Content -Raw $runtimePath | ConvertFrom-Json
	$bunVersion = $runtime.version
	$bunAsset = $runtime.assets.PSObject.Properties[$platform]
	if (-not $bunVersion -or -not $bunAsset) { throw "dg-skills: runtime.json in $tag has no bun asset for $platform" }
	$bunFile = $bunAsset.Value.file
	$bunDir = Join-Path $dgHome "runtime\bun-v$bunVersion"
	$libAsset = "dg-lib-$releaseVersion.tar.gz"
	$libDir = Join-Path $dgHome "lib\$releaseVersion"

	$bunZip = Join-Path $work $bunFile
	$needBun = -not (Test-Path -LiteralPath (Join-Path $bunDir "bun.exe"))
	if ($needBun) {
		Write-Host "Downloading bun $bunVersion ($platform)..."
		Invoke-WebRequest -Headers $headers -Uri "https://github.com/oven-sh/bun/releases/download/bun-v$bunVersion/$bunFile" -OutFile $bunZip
		Assert-DgSha256 $bunZip $bunFile $bunAsset.Value.sha256
	}

	$libTar = Join-Path $work $libAsset
	$needLib = -not (Test-Path -LiteralPath (Join-Path $libDir "dg.js"))
	if ($needLib) {
		Write-Host "Downloading $libAsset..."
		$expectedLib = Get-DgSumsEntry $sumsPath $libAsset
		if (-not $expectedLib) { throw "dg-skills: SHA256SUMS in $tag has no entry for $libAsset" }
		Save-DgAsset $rel $libAsset $libTar
		Assert-DgSha256 $libTar $libAsset $expectedLib
	}

	New-Item -ItemType Directory -Force -Path (Join-Path $dgHome "runtime"), (Join-Path $dgHome "lib"), $binDir | Out-Null

	if ($needBun) {
		$stage = Join-Path $work "bun-stage"
		Expand-Archive -Path $bunZip -DestinationPath $stage -Force
		$inner = Join-Path $stage ([System.IO.Path]::GetFileNameWithoutExtension($bunFile))
		if (-not (Test-Path -LiteralPath (Join-Path $inner "bun.exe"))) { throw "dg-skills: $bunFile has no bun.exe" }
		if (Test-Path -LiteralPath $bunDir) { Remove-Item -Recurse -Force $bunDir }
		Copy-Item -Recurse -Path $inner -Destination $bunDir
	}

	if ($needLib) {
		$stage = Join-Path $work "lib-stage"
		New-Item -ItemType Directory -Force -Path $stage | Out-Null
		tar -xzf $libTar -C $stage
		if ($LASTEXITCODE -ne 0) { throw "dg-skills: could not extract $libAsset" }
		if (-not (Test-Path -LiteralPath (Join-Path $stage "dg.js"))) { throw "dg-skills: $libAsset has no dg.js" }
		if (Test-Path -LiteralPath $libDir) { Remove-Item -Recurse -Force $libDir }
		Copy-Item -Recurse -Path $stage -Destination $libDir
	}

	Set-DgJunction (Join-Path $dgHome "runtime\current") $bunDir
	Set-DgJunction (Join-Path $dgHome "lib\current") $libDir

	foreach ($program in @("dg-skills", "dg-agent", "dg-daemon")) {
		$old = Join-Path $binDir "$program.exe"
		if (Test-Path -LiteralPath $old) {
			try { Remove-Item -LiteralPath $old -Force } catch { Move-Item -LiteralPath $old -Destination "$old.old-$([guid]::NewGuid())" }
		}
		Remove-Item -LiteralPath (Join-Path $binDir ".$program.version") -Force -ErrorAction SilentlyContinue
		$shim = "@echo off`r`n`"$dgHome\runtime\current\bun.exe`" `"$dgHome\lib\current\dg.js`" $program %*`r`n"
		[System.IO.File]::WriteAllText((Join-Path $binDir "$program.cmd"), $shim)
	}
	Write-Host "dg runtime $bunVersion and bundle $releaseVersion installed at $dgHome"

	$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
	$pathParts = @($userPath -split ";" | Where-Object { $_ })
	if ($pathParts -notcontains $binDir) {
		$newPath = (@($pathParts) + $binDir) -join ";"
		[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
		Write-Host "added $binDir to the user PATH; open a new shell"
	}

	if ($wantSkillsOnly) { exit 0 }

	$installArgs = @("install")
	if ($wantCliOnly) { $installArgs += "--cli-only" }
	elseif ($wantAgentOnly) { $installArgs += "--agent-only" }
	else { Write-Host "Setting up the dg-ai-extension..." }
	if ($script:pinnedVersion) { $installArgs += @("--version", $script:pinnedVersion) }

	$env:DG_SKILLS_BOOTSTRAP = "1"
	& (Join-Path $binDir "dg-skills.cmd") @installArgs
	$exitCode = $LASTEXITCODE
} finally {
	Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
if ($exitCode -ne 0) { exit $exitCode }

if ($wantCodex) {
	$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
	$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dg-ai-" + [guid]::NewGuid())
	$archive = Join-Path $tmpDir "dg-ai.zip"
	New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
	try {
		Invoke-WebRequest -Headers $headers -Uri "https://github.com/$repo/archive/refs/tags/$tag.zip" -OutFile $archive
		$sourceRoot = Expand-DgSourceArchive -Archive $archive -Destination (Join-Path $tmpDir "source")
		$skillsDir = Join-Path $codexRoot "skills"
		New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
		foreach ($skill in Get-ChildItem -Directory (Join-Path $sourceRoot "plugins\dg\skills")) {
			if (($wantCliOnly -or $wantAgentOnly) -and (Select-String -Path (Join-Path $skill.FullName "SKILL.md") -Pattern "^requires:.*extension" -Quiet)) { continue }
			Copy-Item -Recurse -Force $skill.FullName $skillsDir
		}
	} finally {
		Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
	}
	Write-Host "Codex skills installed in $skillsDir"
}
