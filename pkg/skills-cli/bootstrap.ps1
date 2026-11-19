# Install the dg runtime and bundle for Windows into %LOCALAPPDATA%\dg, then run `dg-skills install`.
#
#   irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
#
# CLI-only (skip the extension): set $env:DG_CLI_ONLY = "1" first.
# Agent-only (for a non-Claude agent that only needs phone): set $env:DG_AGENT_ONLY = "1" first.
# Skills-only (copy the skill files, then the runtime and bundle; no extension and no
# `dg-skills install`): set $env:DG_SKILLS_ONLY = "1" first.
# DG_SKILLS_NO_CLI = "1" with it keeps an offline copy of the skill files and downloads no release.
#
# Pin a version instead of the newest release: set $env:DG_VERSION = "<x.y.z>" first
# (piped `irm | iex` cannot take parameters), or pass -Version <x.y.z> when running a
# saved copy of this file. A leading v is accepted.
#
# Layout: runtime\bun-v<bun>, lib\<release>, runtime\current and lib\current junctions, and
# bin\dg.cmd, bin\dg-skills.cmd, bin\dg-agent.cmd and bin\dg-daemon.cmd launchers (the dg, dg-skills,
# dg-agent and dg-daemon launchers). Every download is verified
# against SHA256SUMS or runtime.json before anything is installed. Re-running upgrades in place.
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
	$retiredHashes = @{
		"browser" = @("b969dfcd494d1232535baa69aaea096c45bdd4d7b05d08ba1934848f1725d03d", "d6a0bc0f0be59c15d66071106e9a3f80de76411a859376e70e9c45cecda431bc", "8dbdb20953aadcf2a0f9f6579ed228a7e884b2dd0ac044040ae08fbe606d1eb5", "cd5c05e9e74ceb784c358df6d94dc6d859fd5629abc0c440cdcad3914d3b7ee3", "dcfa9b73b33518527707f4d4cbf1dd6102b02656fb04f933cf4d7d134d6a15ee", "8000b280e0f6b100fed10da775e095ee64233a775753dfcd52af5a514e289384", "c4b44d927c2d44d8db1edb866a6c05cf93d35d9051e540b2cc1a1b6c2ddd7276", "e49882446a5b2fbb5dede1aa196d870377b0621eead0d3c00d8eefe89459bf84", "dda25c04098fc1b8d47287314bb9275f7e7c2d98c841c242ab25ac97d41323cc", "be8b6a3feb55e35abf4f827f36d2552ed977cee9a8cb2d44ba8e348c5c15079c", "ac752084481c4f2243a9957ef886185a758fc531aa7bfed47d3885c0f72ea712", "d4603c4b80e8c79c29abfe4705a6b8ddea19371db81b218f9feea451571c9829", "b0850898d8586b779f016d2cb1d07b79e9fee829e76aa199cba0c2070fa7e85f", "6cbaad37b810c89fb7c67f0a3eb251909ab0dceea67b3539d3d29992cc5f27c1", "2d984bc20bec7a2942d5c5a945447b1ab0bd8fac0db57414748c19054c3c8225", "68fe24a50f58c4519ab5531ca8958c9e1b260e7ab5a46c30e2844bd8a3d8fd3f", "cd7757c1c3d0d37f55937894924a373856ac298e4e967902b6b31f72c047ab49", "a8778e69801e97add7ab360f3bf2de713eaa198d120a13b573b83af866f5159e", "cae1f4cb6dc1542ac09648e92739ba3e85358cd4150ddcea9c02f37d09abf974", "5cc7d86cde958b20f160c5e7464f82b0a950dbdf6536bdfba486cae2208828d7", "3adf53ef20e804bc1c1097ac5ef2f477b206cccef07918b04026c6a7794a621d", "1a96b704aefa69f44264be622c937a0edabbe2929c25452ef724e5adaa170bd8", "0ead03f59800b9f61eda85ebe24c7ae24b9231d149d19f8ae4288e40e9cc3f36", "1661d1c79902c420156a040fc654a2a161c2a039f221fc394b071a5470747355", "8a6902729d3602d5dfef9f45b43b7cd90a4f3532cc169a7746629a92c66dac6f", "3397015189d9466b3709112e71d54644603da9ada241e96f5778ef42c5e22410", "ff38fc419e07fc60efbd24fdeca191c446a10de28de8fd2280bc00d04638f039", "b8f43b137d532362d02e66bd3ec994d7df0117dccac753e473f51d07f6912c23", "2a6a9bf6962b558cf0c418206ba8e942dc1cfa5e69e60d3ef30949238067c903", "4c76b530c8262cf18f34339b77b5abbd3ff5b9adcb7eba4e74944ca06e189689", "926fa3ec0b9a4df41092b7412fce783dd8d9b7b8adce16d40666c19dd466da4d", "d83397cd3e6d119e88b3d7076b1c70dae61dc2303d28f2c54551ef1018b1c189", "dbe38cc5affd5a9646aed5ec3b6cf7996a3a86b39d93f4509c8606873c1839cb", "2b4f458a849518d038d393ce4a95bfe110acad175ad49e4979b65b4369260278", "1f93ee9b3e672eeb85fb63076403db8dc818e010bfe40f0d12841237c2ce6886", "abba20a6b591f8e2782ba7bfc21cd89bac12509eb9ba662a2ead3df273bb5e3f", "87299ac43a0a7e83ccaff96f4a13a6d84771b9a69b058c239ba78230ade54847", "aecd7a52ae736542406fc2923bb1a7285e2f802aba89d3da4a484ba8ddc8128a")
		"teach" = @("b32cdde3ab7f7239d157dd2225c984e48c02aa981cb962b42cdda5cdd1c4dc68", "bb06ec5c6763216f76a7af5fbbea839476008747740ded023d285a5afddbd3c9", "f5c44555744159f345cfdd1ab1eede4977f06cf31b911edffc48e35747b313a9", "d173128190d9450759d3ca5a261987448e176665fabb9cd7a0ffba4d4f006020")
		"wait-what" = @("3ff07fa007759e417d95c4885ed333a84119cc0d621f7e3d805ca46b6ffb3dd6", "6f40fe8148898ee8cb306b8fec3f8f674ee346f5ef54bf9f2d2790e43e1e1f4a", "9b0cee4706ad7eb61490d3cb997b1dad7cfebd2dc974e4735b5a2fb65a1bcb3e", "f923f0a108954acb787d4b9d331bc44525ab70721df0e00e719284007a773bd0")
	}
	foreach ($retired in @("browser", "phone-friend", "teach", "wait-what")) {
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

if ($env:DG_SKILLS_ONLY -eq "1" -and $env:DG_CLI_ONLY -eq "1") {
	throw "dg-skills: set only one of DG_SKILLS_ONLY and DG_CLI_ONLY"
}
if ($env:DG_SKILLS_ONLY -eq "1" -and $env:DG_AGENT_ONLY -eq "1") {
	throw "dg-skills: set only one of DG_SKILLS_ONLY and DG_AGENT_ONLY"
}
if ($env:DG_CLI_ONLY -eq "1" -and $env:DG_AGENT_ONLY -eq "1") {
	throw "dg-skills: set only one of DG_CLI_ONLY and DG_AGENT_ONLY"
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

if ($env:DG_SKILLS_ONLY -eq "1") {
	$skillsDest = if ($env:DG_SKILLS_DEST) { $env:DG_SKILLS_DEST } else { Join-Path $dgHome "skills" }
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

	foreach ($program in @("dg-skills", "dg-agent", "dg-daemon", "dg")) {
		$cmd = Join-Path $binDir "$program.cmd"
		if ($program -ne "dg") {
			$old = Join-Path $binDir "$program.exe"
			if (Test-Path -LiteralPath $old) {
				try { Remove-Item -LiteralPath $old -Force } catch { Move-Item -LiteralPath $old -Destination "$old.old-$([guid]::NewGuid())" }
			}
			Remove-Item -LiteralPath (Join-Path $binDir ".$program.version") -Force -ErrorAction SilentlyContinue
		}
		$dangling = $false
		try { $final = [System.IO.FileInfo]::new($cmd).ResolveLinkTarget($true); $dangling = $null -ne $final -and -not $final.Exists } catch { $dangling = $false }
		if ($program -eq "dg" -and -not $dangling -and (Test-Path -LiteralPath $cmd)) {
			$item = Get-Item -LiteralPath $cmd -Force
			$isLauncher = $false
			if (-not $item.PSIsContainer) {
				try {
					$bytes = [System.IO.File]::ReadAllBytes($item.FullName)
					$head = @($bytes | Select-Object -First 4096)
					if ($head.Count -gt 0 -and ($head -notcontains 0)) {
						$isLauncher = [System.Text.Encoding]::UTF8.GetString([byte[]]$head).Contains('lib\current\dg.js')
					}
				} catch { $isLauncher = $false }
			}
			if (-not $isLauncher) {
				Write-Host "dg: kept $cmd; it is not a dg launcher. Remove it or rename it, then run dg-skills install again"
				continue
			}
		}
		if ([System.IO.FileInfo]::new($cmd).LinkTarget -or (Get-Item -LiteralPath $cmd -Force -ErrorAction SilentlyContinue).LinkType) {
			if ((Get-Item -LiteralPath $cmd -Force).PSIsContainer) { [System.IO.Directory]::Delete($cmd) } else { [System.IO.File]::Delete($cmd) }
		}
		$shim = "@echo off`r`n`"$dgHome\runtime\current\bun.exe`" `"$dgHome\lib\current\dg.js`" $program %*`r`n"
		[System.IO.File]::WriteAllText($cmd, $shim)
	}
	Write-Host "dg runtime $bunVersion and bundle $releaseVersion installed at $dgHome"

	$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
	$pathParts = @($userPath -split ";" | Where-Object { $_ })
	if ($pathParts -notcontains $binDir) {
		$newPath = (@($pathParts) + $binDir) -join ";"
		[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
		Write-Host "added $binDir to the user PATH; open a new shell"
	}

	if ($env:DG_SKILLS_ONLY -eq "1") { exit 0 }

	$installArgs = @("install")
	if ($env:DG_CLI_ONLY -eq "1") { $installArgs += "--cli-only" }
	elseif ($env:DG_AGENT_ONLY -eq "1") { $installArgs += "--agent-only" }
	else { Write-Host "Setting up the dg-ai-extension..." }
	if ($script:pinnedVersion) { $installArgs += @("--version", $script:pinnedVersion) }

	$env:DG_SKILLS_BOOTSTRAP = "1"
	& (Join-Path $binDir "dg-skills.cmd") @installArgs
	$exitCode = $LASTEXITCODE
} finally {
	Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
if ($exitCode -ne 0) { exit $exitCode }

if ($env:DG_INSTALL_CODEX -eq "1") {
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
			if (($env:DG_CLI_ONLY -eq "1" -or $env:DG_AGENT_ONLY -eq "1") -and (Select-String -Path (Join-Path $skill.FullName "SKILL.md") -Pattern "^requires:.*extension" -Quiet)) { continue }
			Copy-Item -Recurse -Force $skill.FullName $skillsDir
		}
	} finally {
		Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
	}
	Write-Host "Codex skills installed in $skillsDir"
}
