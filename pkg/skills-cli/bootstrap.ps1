# Install the compiled dg-skills CLI for Windows into %USERPROFILE%\.dg\bin.
#
#   irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
#
# Idempotent: re-running overwrites the binary with the newest skills-v* release.
$ErrorActionPreference = "Stop"

$repo = "detailedghost/dg-ai"
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$asset = "dg-skills-windows-$arch.exe"
$binDir = Join-Path $env:USERPROFILE ".dg\bin"
$dest = Join-Path $binDir "dg-skills.exe"

$headers = @{ "User-Agent" = "dg-ai" }
$releases = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases?per_page=30"
$rel = $releases | Where-Object { $_.tag_name -like "skills-v*" -and -not $_.draft } | Select-Object -First 1
$url = $rel.assets | Where-Object { $_.name -eq $asset } | Select-Object -ExpandProperty browser_download_url -First 1

if (-not $url) { throw "dg-skills: no $asset in latest skills-v* release" }

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Invoke-WebRequest -Headers $headers -Uri $url -OutFile $dest

# Stamp the installed version so `dg-skills install` won't re-download the binary.
Set-Content -Path (Join-Path $binDir ".dg-skills.version") -Value $rel.tag_name.Replace("skills-v", "")
Write-Host "dg-skills installed at $dest"

if ($env:PATH -notlike "*$binDir*") {
	Write-Host "Add to PATH:  `$env:PATH = `"$binDir;`$env:PATH`""
}

# Set up the browser extension too, so one command installs everything.
Write-Host "Setting up the dg-ai-extension…"
& $dest install

# Optional Codex skill installation. Set DG_INSTALL_CODEX=1 to copy the
# repository's skills into CODEX_HOME (default: $HOME\.codex\skills).
if ($env:DG_INSTALL_CODEX -eq "1") {
	$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
	$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dg-ai-" + [guid]::NewGuid())
	$archive = Join-Path $tmpDir "dg-ai.zip"
	New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
	Invoke-WebRequest -Headers $headers -Uri "https://github.com/$repo/archive/refs/heads/master.zip" -OutFile $archive
	Expand-Archive -Path $archive -DestinationPath $tmpDir -Force
	$skillsDir = Join-Path $codexRoot "skills"
	New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
	Copy-Item -Recurse -Force (Join-Path $tmpDir "dg-ai-master\pkg\skills\*") $skillsDir
	Remove-Item -Recurse -Force $tmpDir
	Write-Host "Codex skills installed in $skillsDir"
}
