#!/bin/sh
# Install the compiled dg program into the per-OS data dir, then run `dg install`.
#
#   curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
#   ... | sh -s -- --cli-only    skip the extension.
#   ... | sh -s -- --agent-only  install for a non-Claude agent that only needs phone.
#   ... | sh -s -- --skills-only copy the skill files, then install the dg program only. It runs
#       no `dg install`, fetches no extension and executes no skill content. Add --no-cli to keep it
#       an offline copy of the skill files (nothing is downloaded from a release), and --dest <dir> to
#       choose where they go.
#   ... | sh -s -- --chat-only    download only the chat skills for Claude chat: the checksum-verified
#       dg-chat-skills-<x.y.z>.zip unpacked into ./dg-chat-skills (or --dest <dir>), one upload-ready ZIP
#       per skill. No dg program, no extension, and nothing it unpacks is run.
#   ... | sh -s -- --codex       also copy the skills into $CODEX_HOME/skills.
#   ... | sh -s -- --version <x.y.z> (also --version=<x.y.z>): install that release.
# Older scripts may still set DG_CLI_ONLY, DG_AGENT_ONLY, DG_SKILLS_ONLY, DG_SKILLS_NO_CLI, DG_SKILLS_DEST,
# DG_INSTALL_CODEX or DG_VERSION; those keep working, and a flag always wins.
#
# Layout: bin/<release>/dg and a bin/current link in the data dir (~/.local/share/dg on Linux,
# ~/Library/Application Support/dg on macOS, $DG_HOME/data), and a dg link to bin/current/dg in
# ~/.local/bin (or $DG_HOME/bin). The release's dg-linux-x64.gz is unpacked with gzip (the raw dg-linux-x64
# is the fallback), and the unpacked dg-linux-x64 is verified against SHA256SUMS. It must
# report the release version before any link changes. Old dg-skills, dg-agent and dg-daemon launchers are
# removed. A 6.3 runtime/ and lib/ are left in place. Re-running upgrades in place.
# Windows: use bootstrap.ps1 instead.
set -eu

CLI_ONLY="${DG_CLI_ONLY:-0}"
SKILLS_ONLY="${DG_SKILLS_ONLY:-0}"
AGENT_ONLY="${DG_AGENT_ONLY:-0}"
NO_CLI="${DG_SKILLS_NO_CLI:-0}"
INSTALL_CODEX="${DG_INSTALL_CODEX:-0}"
CHAT_ONLY=0
DEST_ARG=""
VERSION_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cli-only) CLI_ONLY=1 ;;
    --skills-only) SKILLS_ONLY=1 ;;
    --agent-only) AGENT_ONLY=1 ;;
    --chat-only) CHAT_ONLY=1 ;;
    --no-cli) NO_CLI=1 ;;
    --codex) INSTALL_CODEX=1 ;;
    --dest=*) DEST_ARG=${1#--dest=} ;;
    --dest)
      shift
      [ "$#" -gt 0 ] || { echo "dg: --dest requires a directory" >&2; exit 1; }
      DEST_ARG=$1
      ;;
    --version=*) VERSION_ARG=${1#--version=} ;;
    --version)
      shift
      [ "$#" -gt 0 ] || { echo "dg: --version requires a value" >&2; exit 1; }
      VERSION_ARG=$1
      ;;
  esac
  shift
done
if [ "$SKILLS_ONLY" = "1" ] && [ "$CLI_ONLY" = "1" ]; then
  echo "dg: pass only one of --skills-only and --cli-only" >&2
  exit 1
fi
if [ "$SKILLS_ONLY" = "1" ] && [ "$AGENT_ONLY" = "1" ]; then
  echo "dg: pass only one of --skills-only and --agent-only" >&2
  exit 1
fi
if [ "$CLI_ONLY" = "1" ] && [ "$AGENT_ONLY" = "1" ]; then
  echo "dg: pass only one of --cli-only and --agent-only" >&2
  exit 1
fi
if [ "$CHAT_ONLY" = "1" ]; then
  for other in "CLI_ONLY:--cli-only" "SKILLS_ONLY:--skills-only" "AGENT_ONLY:--agent-only" "INSTALL_CODEX:--codex" "NO_CLI:--no-cli"; do
    eval "set_to=\${${other%%:*}}"
    if [ "$set_to" = "1" ]; then
      echo "dg: --chat-only installs nothing but the chat skills; drop ${other#*:}" >&2
      exit 1
    fi
  done
fi

normalize_version() {
  v=$1
  case "$v" in
    v*) v=${v#v} ;;
  esac
  printf '%s' "$v"
}

PINNED_VERSION=""
if [ -n "${VERSION_ARG}" ]; then
  PINNED_VERSION=$(normalize_version "${VERSION_ARG}")
elif [ -n "${DG_VERSION:-}" ]; then
  PINNED_VERSION=$(normalize_version "${DG_VERSION}")
fi

TMP_PATHS=""
track_tmp() {
  TMP_PATHS="${TMP_PATHS}${1}
"
}
cleanup_tmp() {
  printf '%s' "$TMP_PATHS" | while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] && rm -rf "$path"
  done
}
trap cleanup_tmp EXIT

die() {
  echo "dg: $1" >&2
  exit 1
}

CURL="${DG_CURL:-curl}"
UNAME="${DG_UNAME:-uname}"

link_current() {
  staged="$1.$$.tmp"
  rm -f "$staged"
  ln -s "$2" "$staged"
  mv -T "$staged" "$1" 2>/dev/null || mv -h -f "$staged" "$1" 2>/dev/null || {
    rm -f "$staged"
    die "could not link $1"
  }
}

# Copy skill directories as data. A skill is an immediate child that contains
# SKILL.md. The same rule lives in @dg/common filesToInstall. Symlinks are
# refused. Files are written mode 0644 and never executed.
retired_is_dg_copy() {
  case $2 in
    browser) known="b969dfcd494d1232535baa69aaea096c45bdd4d7b05d08ba1934848f1725d03d d6a0bc0f0be59c15d66071106e9a3f80de76411a859376e70e9c45cecda431bc 8dbdb20953aadcf2a0f9f6579ed228a7e884b2dd0ac044040ae08fbe606d1eb5 cd5c05e9e74ceb784c358df6d94dc6d859fd5629abc0c440cdcad3914d3b7ee3 dcfa9b73b33518527707f4d4cbf1dd6102b02656fb04f933cf4d7d134d6a15ee 8000b280e0f6b100fed10da775e095ee64233a775753dfcd52af5a514e289384 c4b44d927c2d44d8db1edb866a6c05cf93d35d9051e540b2cc1a1b6c2ddd7276 e49882446a5b2fbb5dede1aa196d870377b0621eead0d3c00d8eefe89459bf84 dda25c04098fc1b8d47287314bb9275f7e7c2d98c841c242ab25ac97d41323cc be8b6a3feb55e35abf4f827f36d2552ed977cee9a8cb2d44ba8e348c5c15079c ac752084481c4f2243a9957ef886185a758fc531aa7bfed47d3885c0f72ea712 d4603c4b80e8c79c29abfe4705a6b8ddea19371db81b218f9feea451571c9829 b0850898d8586b779f016d2cb1d07b79e9fee829e76aa199cba0c2070fa7e85f 6cbaad37b810c89fb7c67f0a3eb251909ab0dceea67b3539d3d29992cc5f27c1 2d984bc20bec7a2942d5c5a945447b1ab0bd8fac0db57414748c19054c3c8225 68fe24a50f58c4519ab5531ca8958c9e1b260e7ab5a46c30e2844bd8a3d8fd3f cd7757c1c3d0d37f55937894924a373856ac298e4e967902b6b31f72c047ab49 a8778e69801e97add7ab360f3bf2de713eaa198d120a13b573b83af866f5159e cae1f4cb6dc1542ac09648e92739ba3e85358cd4150ddcea9c02f37d09abf974 5cc7d86cde958b20f160c5e7464f82b0a950dbdf6536bdfba486cae2208828d7 3adf53ef20e804bc1c1097ac5ef2f477b206cccef07918b04026c6a7794a621d 1a96b704aefa69f44264be622c937a0edabbe2929c25452ef724e5adaa170bd8 0ead03f59800b9f61eda85ebe24c7ae24b9231d149d19f8ae4288e40e9cc3f36 1661d1c79902c420156a040fc654a2a161c2a039f221fc394b071a5470747355 8a6902729d3602d5dfef9f45b43b7cd90a4f3532cc169a7746629a92c66dac6f 3397015189d9466b3709112e71d54644603da9ada241e96f5778ef42c5e22410 ff38fc419e07fc60efbd24fdeca191c446a10de28de8fd2280bc00d04638f039 b8f43b137d532362d02e66bd3ec994d7df0117dccac753e473f51d07f6912c23 2a6a9bf6962b558cf0c418206ba8e942dc1cfa5e69e60d3ef30949238067c903 4c76b530c8262cf18f34339b77b5abbd3ff5b9adcb7eba4e74944ca06e189689 926fa3ec0b9a4df41092b7412fce783dd8d9b7b8adce16d40666c19dd466da4d d83397cd3e6d119e88b3d7076b1c70dae61dc2303d28f2c54551ef1018b1c189 dbe38cc5affd5a9646aed5ec3b6cf7996a3a86b39d93f4509c8606873c1839cb 2b4f458a849518d038d393ce4a95bfe110acad175ad49e4979b65b4369260278 1f93ee9b3e672eeb85fb63076403db8dc818e010bfe40f0d12841237c2ce6886 abba20a6b591f8e2782ba7bfc21cd89bac12509eb9ba662a2ead3df273bb5e3f 87299ac43a0a7e83ccaff96f4a13a6d84771b9a69b058c239ba78230ade54847 aecd7a52ae736542406fc2923bb1a7285e2f802aba89d3da4a484ba8ddc8128a" ;;
    teach) known="b32cdde3ab7f7239d157dd2225c984e48c02aa981cb962b42cdda5cdd1c4dc68 bb06ec5c6763216f76a7af5fbbea839476008747740ded023d285a5afddbd3c9 f5c44555744159f345cfdd1ab1eede4977f06cf31b911edffc48e35747b313a9 d173128190d9450759d3ca5a261987448e176665fabb9cd7a0ffba4d4f006020" ;;
    wait-what) known="3ff07fa007759e417d95c4885ed333a84119cc0d621f7e3d805ca46b6ffb3dd6 6f40fe8148898ee8cb306b8fec3f8f674ee346f5ef54bf9f2d2790e43e1e1f4a 9b0cee4706ad7eb61490d3cb997b1dad7cfebd2dc974e4735b5a2fb65a1bcb3e f923f0a108954acb787d4b9d331bc44525ab70721df0e00e719284007a773bd0" ;;
    *) return 0 ;;
  esac
  [ -f "$1/$2/SKILL.md" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    hash=$(sha256sum "$1/$2/SKILL.md" | cut -d' ' -f1)
  else
    hash=$(shasum -a 256 "$1/$2/SKILL.md" | cut -d' ' -f1)
  fi
  case " $known " in
    *" $hash "*) return 0 ;;
  esac
  return 1
}

copy_skill_tree() {
  src=$1
  dest=$2
  manifest=$(mktemp)
  track_tmp "$manifest"
  if [ ! -d "$src" ]; then
    echo "dg: no skills directory at ${src}" >&2
    exit 1
  fi
  if find "$src" -type l | grep -q .; then
    echo "dg: refusing to copy a symlink from ${src}" >&2
    exit 1
  fi
  refuse_persona_links "$src"
  mkdir -p "$dest"
  for retired in browser phone-friend teach wait-what; do
    if retired_is_dg_copy "$dest" "$retired"; then
      rm -rf "${dest:?}/${retired}"
    fi
  done
  found=0
  for skill in "$src"/*/; do
    [ -d "$skill" ] || continue
    [ -f "${skill}SKILL.md" ] || continue
    found=1
    name=$(basename "$skill")
    rm -rf "${dest}/${name}"
    filelist=$(mktemp)
    track_tmp "$filelist"
    find "$skill" -type f >"$filelist"
    while IFS= read -r file || [ -n "$file" ]; do
      [ -n "$file" ] || continue
      rel=${file#"$skill"}
      rel=${rel#/}
      case "$rel" in
        ""|..|../*|*/..|*/../*)
          echo "dg: refusing ${rel}" >&2
          exit 1
          ;;
      esac
      out="${dest}/${name}/${rel}"
      mkdir -p "$(dirname "$out")"
      cp "$file" "$out"
      chmod 644 "$out"
      printf '%s\n' "${name}/${rel}" >>"$manifest"
    done <"$filelist"
    rm -f "$filelist"
  done
  if [ "$found" -ne 1 ]; then
    echo "dg: ${src} has no skill directories" >&2
    exit 1
  fi
  sort "$manifest"
  count=$(wc -l <"$manifest" | tr -d " ")
  echo "Installed ${count} skill files at ${dest}."
  copy_personas "$src" "$dest"
  echo "Skills-only install: no skill content was executed. Fetching the dg program (no extension)."
  rm -f "$manifest"
}

persona_source() {
  CDPATH= cd -- "$1/.." 2>/dev/null && printf '%s\n' "$(pwd)/agents"
}

refuse_persona_links() {
  agents_src=$(persona_source "$1") || return 0
  [ -d "$agents_src" ] || return 0
  if find "$agents_src" -type l | grep -q .; then
    echo "dg: refusing to copy a symlink persona from ${agents_src}" >&2
    exit 1
  fi
}

copy_personas() {
  agents_src=$(persona_source "$1") || return 0
  [ -d "$agents_src" ] || return 0
  agents=$(CDPATH= cd -- "$2/.." && pwd)/agents
  mkdir -p "$agents"
  count=0
  for persona in "$agents_src"/*.md; do
    [ -f "$persona" ] || continue
    rm -f "${agents}/$(basename "$persona")"
    cp "$persona" "${agents}/$(basename "$persona")"
    chmod 644 "${agents}/$(basename "$persona")"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] && echo "Installed ${count} personas at ${agents}."
  return 0
}

REPO="detailedghost/dg-ai"
PER_PAGE=100
PAGE_CAP=10
releases=""
tag=""
candidates=""

resolve_release() {
  [ -n "${tag}" ] && return
  want=""
  if [ -n "${PINNED_VERSION}" ]; then
    want="v${PINNED_VERSION}"
  fi
  page=1
  while [ "${page}" -le "${PAGE_CAP}" ]; do
    batch=$("$CURL" -fsSL -H "User-Agent: dg-ai" \
      "https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}")
    releases="${releases}${batch}"
    found=$(printf '%s' "${batch}" | tr -d '\n' |
      grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+"([^{}]*"draft"[[:space:]]*:[[:space:]]*true)?' |
      grep -v 'true$' |
      sed -E 's/.*"(v[^"]*)".*/\1/' || true)
    candidates="${candidates}${found}
"
    batch_count=$(printf '%s' "${batch}" | grep -o '"tag_name"[[:space:]]*:' | wc -l)
    [ "${batch_count}" -lt "${PER_PAGE}" ] && break
    page=$((page + 1))
  done

  if [ -n "${want}" ]; then
    if printf '%s\n' "${candidates}" | grep -qxF "${want}"; then
      tag="${want}"
    else
      die "no release named ${want} found"
    fi
  else
    tag=$(printf '%s' "${candidates}" | grep -v '^$' |
      sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)
    [ -n "${tag}" ] || die "no vX.Y.Z release found"
  fi
  VERSION=$(normalize_version "${tag}")
}

extract_source_archive() {
  command -v tar >/dev/null 2>&1 || die "tar is required"
  archive_file=$1
  extract_dir=$2
  mkdir -p "$extract_dir"
  tar -xzf "$archive_file" -C "$extract_dir"
  set -- "$extract_dir"/*/
  if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
    echo "dg: expected one directory in the source archive" >&2
    exit 1
  fi
  printf '%s' "${1%/}"
}

skills_tree_source() {
  if [ -n "${DG_SKILLS_SOURCE:-}" ]; then
    SKILLS_SRC="$DG_SKILLS_SOURCE"
    return
  fi
  script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
  repo=$(CDPATH= cd -- "$script_dir/../.." && pwd)
  if [ -d "$repo/plugins/dg/skills" ]; then
    SKILLS_SRC="$repo/plugins/dg/skills"
    return
  fi
  if [ -d "plugins/dg/skills" ]; then
    SKILLS_SRC="$(pwd)/plugins/dg/skills"
    return
  fi
  tmp=$(mktemp -d)
  track_tmp "$tmp"
  archive="${tmp}/dg-ai.tar.gz"
  resolve_release
  "$CURL" -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" -o "$archive"
  source_root=$(extract_source_archive "$archive" "${tmp}/source")
  SKILLS_SRC="${source_root}/plugins/dg/skills"
}

if [ -n "${DG_HOME:-}" ]; then
  BIN="${DG_HOME}/bin"
  ROOT="${DG_HOME}/data"
elif [ "$("$UNAME" -s)" = "Darwin" ]; then
  BIN="${HOME}/.local/bin"
  ROOT="${HOME}/Library/Application Support/dg"
else
  BIN="${HOME}/.local/bin"
  case "${XDG_DATA_HOME:-}" in
    /*) ROOT="${XDG_DATA_HOME}/dg" ;;
    *) ROOT="${HOME}/.local/share/dg" ;;
  esac
fi

sha256_of() {
  $SHA_CMD "$1" | awk '{print $1}' | tr 'A-F' 'a-f'
}

verify_sha256() {
  [ "$(sha256_of "$1")" = "$3" ] || die "checksum mismatch for $2"
}

asset_url() {
  name=$(printf '%s' "$1" | sed -e 's/[.[\^$*]/\\&/g')
  tag_pattern=$(printf '%s' "${tag}" | sed -e 's/[.[\^$*]/\\&/g')
  printf '%s' "${releases}" |
    grep -oE "https://[^\"]+/download/${tag_pattern}/${name}\"" |
    head -1 | tr -d '"'
}

download_asset() {
  url=$(asset_url "$1")
  [ -n "${url}" ] || die "no $1 asset in ${tag}"
  "$CURL" -fsSL -H "User-Agent: dg-ai" -o "$2" "$url"
}

sums_entry() {
  awk -v name="$1" '
    $1 ~ /^[0-9A-Fa-f]{64}$/ {
      n = $2
      sub(/^\*/, "", n)
      if (n == name) { print $1; exit }
    }
  ' "${WORK}/SHA256SUMS" | tr 'A-F' 'a-f'
}

pick_sha_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA_CMD="shasum -a 256"
  else
    die "sha256sum or shasum is required"
  fi
}

# The chat skills are data for a chat upload: ZIPs and a Markdown guide. They are verified,
# unpacked into one folder, and never opened or run.
install_chat_skills() {
  dest=$1
  for tool in "$CURL" unzip; do
    command -v "$tool" >/dev/null 2>&1 || die "${tool} is required"
  done
  pick_sha_cmd
  resolve_release
  WORK=$(mktemp -d)
  track_tmp "${WORK}"
  asset="dg-chat-skills-${VERSION}.zip"
  download_asset SHA256SUMS "${WORK}/SHA256SUMS"
  expected=$(sums_entry "${asset}")
  [ -n "${expected}" ] || die "SHA256SUMS in ${tag} has no entry for ${asset}"
  echo "Downloading ${asset}..."
  download_asset "${asset}" "${WORK}/${asset}"
  verify_sha256 "${WORK}/${asset}" "${asset}" "${expected}"
  entries=$(unzip -Z1 "${WORK}/${asset}") || die "${asset} is not a ZIP"
  [ -n "${entries}" ] || die "${asset} is empty"
  for entry in ${entries}; do
    case "${entry}" in
      UPLOAD.md) ;;
      dg-*.zip)
        case "${entry}" in
          */* | *..*) die "refusing ${entry} in ${asset}" ;;
        esac
        ;;
      *) die "refusing ${entry} in ${asset}" ;;
    esac
  done
  mkdir -p "${dest}"
  unzip -oq "${WORK}/${asset}" -d "${dest}"
  for entry in ${entries}; do chmod 644 "${dest}/${entry}"; done
  echo "Chat skills ${VERSION} are in ${dest}:"
  for entry in ${entries}; do
    case "${entry}" in dg-*.zip) echo "  ${entry}" ;; esac
  done
  echo "Upload each ZIP as a skill in Claude: Customize, then Skills, then Upload a skill."
  echo "Turn on code execution in Settings, under Capabilities. A Team or Enterprise owner can add them for everyone."
  echo "Chat-only install: nothing else was installed and nothing was run."
}

if [ "$SKILLS_ONLY" = "1" ]; then
  skills_tree_source
  copy_skill_tree "${SKILLS_SRC}" "${DEST_ARG:-${DG_SKILLS_DEST:-${ROOT}/skills}}"
  if [ "${NO_CLI}" = "1" ]; then
    echo "Skipped the dg CLI (--no-cli): offline copy only."
    exit 0
  fi
fi

if [ "$CHAT_ONLY" = "1" ]; then
  install_chat_skills "${DEST_ARG:-dg-chat-skills}"
  exit 0
fi

os=$("$UNAME" -s)
arch=$("$UNAME" -m)
case "$os" in
Linux) family="linux" ;;
Darwin) family="darwin" ;;
*) die "unsupported OS '$os' - use bootstrap.ps1 on Windows" ;;
esac
case "$arch" in
x86_64 | amd64) cpu="x64" ;;
aarch64 | arm64) cpu="arm64" ;;
*) die "unsupported arch '$arch'" ;;
esac
platform="${family}-${cpu}"
if [ "$platform" = "linux-x64" ]; then
  cpuinfo="${DG_CPUINFO_FILE:-/proc/cpuinfo}"
  if [ -r "$cpuinfo" ] && ! grep -qw avx2 "$cpuinfo"; then
    platform="linux-x64-baseline"
  fi
fi

command -v "$CURL" >/dev/null 2>&1 || die "$CURL is required"
pick_sha_cmd

resolve_release

ASSET="dg-${platform}"
VERSION_DIR="${ROOT}/bin/${VERSION}"
mkdir -p "${ROOT}/bin" "${BIN}"

select_asset() {
  FETCH="${ASSET}"
  GZIP="${DG_GZIP:-gzip}"
  if command -v "$GZIP" >/dev/null 2>&1 && [ -n "$(asset_url "${ASSET}.gz")" ]; then
    FETCH="${ASSET}.gz"
  fi
}

fetch_program() {
  echo "Downloading ${FETCH}..."
  download_asset "${FETCH}" "${WORK}/${FETCH}"
  [ "${FETCH}" = "${ASSET}" ] && return
  "$GZIP" -dc "${WORK}/${FETCH}" >"${WORK}/${ASSET}" || die "could not unpack ${FETCH}"
}

install_program() {
  WORK=$(mktemp -d)
  track_tmp "${WORK}"
  download_asset SHA256SUMS "${WORK}/SHA256SUMS"
  expected=$(sums_entry "${ASSET}")
  [ -n "${expected}" ] || die "SHA256SUMS in ${tag} has no entry for ${ASSET}"
  select_asset
  fetch_program
  verify_sha256 "${WORK}/${ASSET}" "${ASSET}" "${expected}"
  stage=$(mktemp -d "${ROOT}/bin/.stage.XXXXXX")
  track_tmp "${stage}"
  cp "${WORK}/${ASSET}" "${stage}/dg"
  chmod 755 "${stage}" "${stage}/dg"
  reported=$("${stage}/dg" --version 2>/dev/null) || die "the downloaded ${ASSET} did not run"
  first=$(printf '%s\n' "${reported}" | awk 'NR == 1 { print $1 }')
  [ "${first}" = "${VERSION}" ] || die "${ASSET} reports '${first}', expected ${VERSION}"
  rm -rf "${VERSION_DIR}"
  mv "${stage}" "${VERSION_DIR}"
}

is_dg_launcher() {
  [ -L "$1" ] && [ ! -e "$1" ] && return 0
  if [ -L "$1" ]; then
    target=$(readlink "$1" || true)
    case "$target" in
      "$2"/*) return 0 ;;
    esac
  fi
  [ -f "$1" ] && [ -r "$1" ] || return 1
  [ "$(head -c 4096 "$1" | tr -d '\000' | wc -c)" = "$(head -c 4096 "$1" | wc -c)" ] || return 1
  head -c 4096 "$1" | grep -qF 'lib/current/dg.js'
}

if [ ! -x "${VERSION_DIR}/dg" ]; then
  install_program
fi
link_current "${ROOT}/bin/current" "${VERSION}"

DG_CMD="${BIN}/dg"
if { [ -e "${BIN}/dg" ] || [ -L "${BIN}/dg" ]; } && ! is_dg_launcher "${BIN}/dg" "${ROOT}/bin"; then
  echo "dg: kept ${BIN}/dg; it is not a dg launcher. Remove it or rename it, then run the bootstrap again" >&2
  DG_CMD="${ROOT}/bin/current/dg"
else
  link_current "${BIN}/dg" "${ROOT}/bin/current/dg"
fi

for old in dg-skills dg-agent dg-daemon; do
  if [ -e "${BIN}/${old}" ] || [ -L "${BIN}/${old}" ]; then
    if is_dg_launcher "${BIN}/${old}" "${ROOT}"; then
      rm -f "${BIN}/${old}" "${BIN}/.${old}.version"
    else
      echo "dg: kept ${BIN}/${old}; it is not a dg launcher and dg no longer uses it" >&2
    fi
  else
    rm -f "${BIN}/.${old}.version"
  fi
done

echo "dg ${VERSION} installed at ${VERSION_DIR}"

case ":${PATH}:" in
*":${BIN}:"*) ;;
*) echo "Add to PATH:  export PATH=\"${BIN}:\$PATH\"" ;;
esac

[ "${SKILLS_ONLY}" = "1" ] && exit 0

install_args=""
[ "${CLI_ONLY}" = "1" ] && install_args=" --cli-only"
[ "${AGENT_ONLY}" = "1" ] && install_args=" --agent-only"
[ -n "${PINNED_VERSION}" ] && install_args="${install_args} --version ${PINNED_VERSION}"

if [ "${CLI_ONLY}" != "1" ] && [ "${AGENT_ONLY}" != "1" ]; then
  echo "Setting up the dg-ai-extension..."
fi
DG_SKILLS_BOOTSTRAP=1 "${DG_CMD}" install${install_args} </dev/null

if [ "${INSTALL_CODEX}" = "1" ]; then
  CODEX_ROOT="${CODEX_HOME:-${HOME}/.codex}"
  tmpdir=$(mktemp -d)
  track_tmp "${tmpdir}"
  archive="${tmpdir}/dg-ai.tar.gz"
  "$CURL" -fsSL -H "User-Agent: dg-ai" \
    "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" -o "${archive}"
  mkdir -p "${CODEX_ROOT}/skills"
  source_root=$(extract_source_archive "${archive}" "${tmpdir}/source")
  for skill in "${source_root}/plugins/dg/skills"/*/; do
    if { [ "${CLI_ONLY}" = "1" ] || [ "${AGENT_ONLY}" = "1" ]; } && grep -qE '^requires:.*extension' "${skill}SKILL.md"; then
      continue
    fi
    cp -R "${skill}" "${CODEX_ROOT}/skills/"
  done
  echo "Codex skills installed in ${CODEX_ROOT}/skills"
fi
