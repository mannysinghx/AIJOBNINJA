#!/usr/bin/env bash
# Local CI for AIJobNinja. Owner rule (2026-10-30): CI runs on this Mac, never on GitHub.
#
# Runs, on one exact commit, the jobs of the GitHub workflows that are no longer run there:
#
#   job               workflow                        where
#   test-linux        test.yml  test (ubuntu-latest)  Linux container (node 24 + node 22.13 + go 1.27)
#   test-macos        test.yml  test (macos-latest)   natively on this Mac, in a throwaway directory
#   cv-visual         test.yml  cv-visual             container with the Docker socket; the CV image
#                                                     is built and run as linux/amd64, as in the workflow
#   upgrade-gate      test.yml  upgrade-gate          Linux container, full history + release tags
#   web               web-ci.yml web                  linux/amd64 container (the browser suites need
#                                                     Google Chrome, which ships for amd64 Linux only)
#   job-finder        job-finder.yml test             Linux container (python 3.12 + bun)
#   plugin-registry   plugin-registry-validate.yml    Linux container (node 24)
#   no-user-data      no-user-data.yml guard          Linux container: the workflow's own script,
#                                                     read from the commit, run over `git diff
#                                                     origin/main...<commit>` instead of the PR API
#
# Not reproduced here: test.yml test (windows-latest) (not reproducible on a Mac), codeql.yml
# (GitHub's CodeQL service) and dependency-review.yml (GitHub's dependency-review service).
# release.yml and Dependabot stay on GitHub.
#
# How the commit gets in: `git archive <sha>` is streamed into each job (never the working
# tree), plus a git pack of that commit so tests that call git see a checkout like
# actions/checkout makes (depth 1, or full history where the workflow uses fetch-depth: 0).
# The copy is checked against the commit (`git status` must be clean) before any step runs.
# No host folder is shared with a container; package caches are named Docker volumes
# (aijobninja-ci-<tool>-cache). Steps run as a non-root user `runner` (uid 1001), like
# GitHub's runner, so permission-based tests behave the same.
#
# Every container, network and image this creates carries the label aijobninja-ci.run=<runId>,
# and an exit trap removes exactly those (unless --keep). At most 2 jobs run at once.
#
# Logs: <git common dir>/ci-local/<sha>.<job>.log. When every job passes and --only was not
# used, <sha>.pass is written next to them (commit, UTC date, per-job result and counts).
#
# Usage:  scripts/ci-local.sh [<commit>] [--only job,job] [--keep]
#   <commit>  default HEAD
#   --only    run just these jobs (no pass record is written)
#   --keep    leave the containers, network and temp directory in place for inspection
#
# Public repo: this only ever runs the commit you name. It never fetches PR code.
set -euo pipefail

# Heavy jobs are spaced out so the two slots rarely hold two of them at once.
ALL_JOBS="web job-finder no-user-data plugin-registry test-linux cv-visual upgrade-gate test-macos"
MAX_PARALLEL=2

# Started from a git hook, these would point every git call below at the wrong place.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
# Logs are read byte-wise: BSD sed stops on any byte sequence invalid in a UTF-8 locale.
export LC_ALL=C LANG=C

commit=HEAD
only=""
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) [ $# -ge 2 ] || { echo "ci-local: --only needs a job list" >&2; exit 2; }; only=$2; shift ;;
    --only=*) only=${1#--only=} ;;
    --keep) keep=1 ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 0 ;;
    -*) echo "ci-local: unknown option $1" >&2; exit 2 ;;
    *) commit=$1 ;;
  esac
  shift
done

jobs=""
if [ -n "$only" ]; then
  for j in $(echo "$only" | tr ',' ' '); do
    case " $ALL_JOBS " in *" $j "*) jobs="$jobs $j" ;; *) echo "ci-local: unknown job '$j' (jobs: $ALL_JOBS)" >&2; exit 2 ;; esac
  done
else
  jobs=$ALL_JOBS
fi

root=$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel)
sha=$(git -C "$root" rev-parse --verify "${commit}^{commit}")
common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)
out="$common/ci-local"
mkdir -p "$out"
# The base the PR-only checks compare against: the local clone's origin/main, as last
# fetched. Not fetched here, so a run never pulls anything in on its own.
base_sha=$(git -C "$root" rev-parse --verify -q "refs/remotes/origin/main^{commit}" || true)

run_id="$(date -u +%Y%m%d%H%M%S)-$$"
label="aijobninja-ci.run=$run_id"
net="aijobninja-ci-$run_id"
# ${TMPDIR%/}: macOS's TMPDIR ends in a slash, and a // in the path breaks tests that compare
# os.tmpdir() with a resolved path.
tmp_base=${TMPDIR:-/tmp}
work=$(mktemp -d "${tmp_base%/}/aijobninja-ci.XXXXXX")
started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
t0=$(date +%s)

IMG_NODE24=node:24-bookworm          # setup-node node-version: '24'
IMG_NODE22=node:22.13-bookworm       # setup-node node-version: '22.13' (test.yml lint step)
IMG_GO=golang:1.27-bookworm          # setup-go go-version: '1.27'
IMG_PY=python:3.12-bookworm          # setup-python python-version: '3.12'
IMG_BUN=oven/bun:latest              # setup-bun with no version = latest
IMG_DOCKER=docker:29-cli             # the docker CLI for cv-visual (talks to this Mac's engine)

# PATH inside the Debian-based job containers once go is added.
LINUX_PATH=/usr/local/go/bin:/home/runner/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

pids=()

kill_tree() {
  local p c
  for p in "$@"; do
    for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done
    kill "$p" 2>/dev/null || true
  done
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ ${#pids[@]} -gt 0 ]; then kill_tree "${pids[@]}"; fi
  if [ "$keep" = 1 ]; then
    echo "ci-local: --keep: left containers/network labelled $label and $work"
    exit "$rc"
  fi
  local ids
  ids=$(docker ps -aq --filter "label=$label" 2>/dev/null || true)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker rm -f -v $ids >/dev/null 2>&1 || true
  ids=$(docker network ls -q --filter "label=$label" 2>/dev/null || true)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker network rm $ids >/dev/null 2>&1 || true
  ids=$(docker image ls -q --filter "label=$label" 2>/dev/null | sort -u || true)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker rmi -f $ids >/dev/null 2>&1 || true
  chmod -R u+w "$work" 2>/dev/null || true
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

needs_docker=0
for j in $jobs; do [ "$j" = test-macos ] || needs_docker=1; done
if [ "$needs_docker" = 1 ]; then
  command -v docker >/dev/null || { echo "ci-local: docker not found" >&2; exit 3; }
  docker info >/dev/null 2>&1 || { echo "ci-local: the Docker engine is not answering (is Docker Desktop running?)" >&2; exit 3; }
fi

echo "ci-local: $sha (run $run_id)"
echo "ci-local: jobs:$(printf ' %s' $jobs)"
echo "ci-local: logs in $out/$sha.<job>.log"

# ---------------------------------------------------------------- helpers (host side)

# Pull the images the selected jobs use, as a runner would get the current tag. A failed
# pull falls back to the local copy when there is one.
pull() { # pull <image> [platform]
  local img=$1 plat=${2:-}
  if docker pull -q ${plat:+--platform "$plat"} "$img" >/dev/null 2>&1; then return 0; fi
  if docker image inspect ${plat:+--platform "$plat"} "$img" >/dev/null 2>&1; then
    echo "ci-local: could not pull $img${plat:+ ($plat)}, using the local copy"; return 0
  fi
  echo "ci-local: could not pull $img${plat:+ ($plat)} and there is no local copy" >&2; return 1
}

# A git pack of the commit: depth 1, or full history (plus origin/main and the release tags
# it contains) for jobs whose workflow checks out with fetch-depth: 0.
pack_of() { # pack_of 1|full
  local tips
  if [ "$1" = 1 ]; then
    git -C "$root" rev-list --objects --no-walk "$sha"
  else
    tips=$(refs_full | awk '{print $2}')
    # shellcheck disable=SC2086
    git -C "$root" rev-list --objects "$sha" $tips
  fi | git -C "$root" pack-objects --stdout -q
}

# "ref object" lines for the full-history copy.
refs_full() {
  local t
  [ -z "$base_sha" ] || echo "refs/remotes/origin/main $base_sha"
  for t in $(git -C "$root" tag --merged "$sha" 2>/dev/null); do
    echo "refs/tags/$t $(git -C "$root" rev-parse "refs/tags/$t")"
  done
}

# Turns a directory holding `git archive` output into a checkout of $sha, then proves the
# files match the commit. Runs inside the container (sh) or on the Mac (macOS leg).
SEED_GIT='set -e
cd "$SRC"
git init -q
git index-pack --stdin >/dev/null
[ "$DEPTH" = 1 ] && echo "$SHA" > .git/shallow
printf "%s\n" "$REFS" | while read -r ref obj; do [ -z "$ref" ] || git update-ref "$ref" "$obj"; done
git remote add origin https://github.com/mannysinghx/AIJOBNINJA
git update-ref --no-deref HEAD "$SHA"
git reset -q
dirty=$(git status --porcelain --untracked-files=all | head -20)
if [ -n "$dirty" ]; then echo "copy does not match $SHA:"; echo "$dirty"; exit 1; fi
echo "checkout of $(git rev-parse HEAD) (depth $DEPTH), $(git ls-files | wc -l | tr -d " ") files, clean"'

ts() { date -u +%H:%M:%S; }

# step <name> <command...>: one workflow step, timed, marked in the job log.
step() {
  local name=$1 s rc=0
  shift
  s=$(date +%s)
  echo
  echo "::ci-local step [$name] start $(ts)"
  "$@" || rc=$?
  if [ $rc -eq 0 ]; then echo "::ci-local step [$name] ok $(( $(date +%s) - s ))s"
  else echo "::ci-local step [$name] FAILED (exit $rc) $(( $(date +%s) - s ))s"; fi
  return $rc
}

# dx <container> <user> <workdir> <PATH> <script>: a `run:` step inside a job container.
dx() {
  docker exec -u "$2" -w "$3" -e CI=true -e PATH="$4" -e HOME="$(home_of "$2")" "$1" \
    bash --noprofile --norc -eo pipefail -c "$5"
}
# dx_sh <container> <workdir> <script>: the same for the Alpine docker:cli image (root, no bash).
dx_sh() { docker exec -w "$2" -e CI=true "$1" sh -eo pipefail -c "$3"; }
home_of() { if [ "$1" = root ]; then echo /root; else echo /home/runner; fi; }

# start_container <job> <image> <platform or ""> [docker run args...] → prints the name
start_container() {
  local job=$1 img=$2 plat=$3 name="aijobninja-ci-$run_id-$1"
  shift 3
  docker run -d --name "$name" --label "$label" --network "$net" \
    ${plat:+--platform "$plat"} -e CI=true "$@" "$img" sleep infinity >/dev/null
  echo "$name"
}

# The non-root user steps run as (GitHub's runner is uid 1001), owning the cache volumes.
add_runner() { # add_runner <container> [cache dirs...]
  local c=$1 d
  shift
  docker exec "$c" sh -c 'id runner >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/bash runner'
  for d in "$@"; do
    docker exec "$c" sh -c "mkdir -p '$d' && [ \"\$(stat -c %u '$d')\" = 1001 ] || chown -R 1001:1001 '$d'"
  done
}

# seed_src <container> <1|full|none> <owner>: the commit's files at /src (+ git, unless none).
seed_src() {
  local c=$1 depth=$2 owner=$3 refs=""
  docker exec "$c" mkdir -p /src
  git -C "$root" archive --format=tar "$sha" | docker exec -i "$c" tar -x -C /src
  if [ "$depth" != none ]; then
    [ "$depth" = 1 ] || refs=$(refs_full)
    pack_of "$depth" | docker exec -i -e SRC=/src -e SHA="$sha" -e DEPTH="$depth" -e REFS="$refs" "$c" sh -c "$SEED_GIT"
  fi
  [ "$owner" = root ] || docker exec "$c" chown -R 1001:1001 /src
}

# Copies a toolchain out of its official image into a job container (no host folder involved).
add_go() { # add_go <container> [platform]
  docker run --rm --label "$label" ${2:+--platform "$2"} "$IMG_GO" tar -C /usr/local -cf - go |
    docker exec -i "$1" tar -x -C /usr/local
}
add_node22() { # add_node22 <container>: node 22.13 at /opt/node-22.13
  docker exec "$1" mkdir -p /opt/node-22.13
  docker run --rm --label "$label" "$IMG_NODE22" tar -C /usr/local -cf - bin/node bin/npm bin/npx lib/node_modules/npm include |
    docker exec -i "$1" tar -x -C /opt/node-22.13
}

npm_cache=(-v aijobninja-ci-npm-cache:/cache/npm -e npm_config_cache=/cache/npm)
go_cache=(-v aijobninja-ci-go-cache:/cache/go -e GOMODCACHE=/cache/go/mod -e GOCACHE=/cache/go/build -e GOTOOLCHAIN=local)

# ---------------------------------------------------------------- jobs

# test.yml › test (ubuntu-latest)
job_test_linux() {
  local c
  c=$(start_container test-linux "$IMG_NODE24" "" "${npm_cache[@]}" "${go_cache[@]}") || return
  step "provision: node 22.13, go 1.27, runner user" eval 'add_node22 "$c" && add_go "$c" && add_runner "$c" /cache/npm /cache/go' || return
  step "checkout (depth 1)" seed_src "$c" 1 runner || return
  step "npm run lint (node 22.13)" dx "$c" runner /src "/opt/node-22.13/bin:$LINUX_PATH" 'node --version && npm run lint' || return
  step "npm install --ignore-scripts (node 24)" dx "$c" runner /src "$LINUX_PATH" 'node --version && go version && npm install --ignore-scripts' || return
  step "node test-all.mjs --quick" dx "$c" runner /src "$LINUX_PATH" 'node test-all.mjs --quick' || return
  step "go test ./... (dashboard)" dx "$c" runner /src/dashboard "$LINUX_PATH" 'go test ./...' || return
}

# test.yml › test (macos-latest), natively on this Mac.
job_test_macos() {
  local d="$work/macos" tc="$out/toolchains" n22 n24 gov path
  mkdir -p "$d/src" "$d/home" "$d/tmp" "$tc" "$out/cache"
  step "checkout (depth 1) into a throwaway directory" mac_checkout "$d" || return
  n22=$(mac_node 22.13) || return
  n24=$(mac_node 24) || return
  gov=$(mac_go 1.27) || return
  path="$n24/bin:$gov/bin:$d/home/go/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  step "npm run lint (node 22.13)" mx "$d/src" "$n22/bin:$path" 'node --version && npm run lint' || return
  step "npm install --ignore-scripts (node 24)" mx "$d/src" "$path" 'node --version && go version && npm install --ignore-scripts' || return
  step "node test-all.mjs --quick" mx "$d/src" "$path" 'node test-all.mjs --quick' || return
  step "go test ./... (dashboard)" mx "$d/src/dashboard" "$path" 'go test ./...' || return
}

mac_checkout() { # mac_checkout <dir>
  git -C "$root" archive --format=tar "$sha" | tar -x -C "$1/src" || return
  pack_of 1 | env HOME="$1/home" GIT_CONFIG_NOSYSTEM=1 SRC="$1/src" SHA="$sha" DEPTH=1 REFS="" sh -c "$SEED_GIT"
}

# mx <dir> <PATH> <script>: a `run:` step on the Mac with a runner-like clean environment:
# its own HOME and TMPDIR inside the throwaway directory, nothing inherited from this shell.
mx() {
  local d="$work/macos"
  (cd "$1" && env -i HOME="$d/home" TMPDIR="$d/tmp/" PATH="$2" CI=true USER="${USER:-runner}" \
    LOGNAME="${USER:-runner}" SHELL=/bin/bash LANG=en_US.UTF-8 TERM=dumb \
    npm_config_cache="$out/cache/npm-macos" GOMODCACHE="$out/cache/go-macos/mod" \
    GOCACHE="$out/cache/go-macos/build" GOTOOLCHAIN=local \
    bash --noprofile --norc -eo pipefail -c "$3")
}

# Official darwin-arm64 toolchains, checksum-verified, cached in <git common dir>/ci-local/toolchains.
# setup-node/setup-go resolve a version prefix to its newest release; so does this.
mac_node() { # mac_node <prefix> → prints the toolchain directory
  local want=$1 v dir tgz sum
  v=$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null | python3 -I -c '
import json, sys
want = sys.argv[1].split(".")
for r in json.load(sys.stdin):
    v = r["version"].lstrip("v").split(".")
    if v[:len(want)] == want: print(r["version"].lstrip("v")); break' "$want" || true)
  if [ -z "$v" ]; then # offline: newest cached match
    v=$(ls "$out/toolchains" 2>/dev/null | grep "^node-v$want[.-]" | sed 's/^node-v//;s/-darwin-arm64$//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
  fi
  [ -n "$v" ] || { echo "ci-local: cannot resolve node $want (offline, nothing cached)" >&2; return 1; }
  dir="$out/toolchains/node-v$v-darwin-arm64"
  if [ ! -x "$dir/bin/node" ]; then
    tgz="$work/node-v$v.tar.gz"
    echo "ci-local: downloading node v$v (darwin-arm64) from nodejs.org" >&2
    curl -fsSL -o "$tgz" "https://nodejs.org/dist/v$v/node-v$v-darwin-arm64.tar.gz" || return 1
    sum=$(curl -fsSL "https://nodejs.org/dist/v$v/SHASUMS256.txt" | awk -v f="node-v$v-darwin-arm64.tar.gz" '$2==f{print $1}')
    [ -n "$sum" ] && [ "$(shasum -a 256 "$tgz" | awk '{print $1}')" = "$sum" ] || { echo "ci-local: node v$v checksum mismatch" >&2; return 1; }
    tar -xzf "$tgz" -C "$out/toolchains" && rm -f "$tgz"
  fi
  echo "$dir"
}
mac_go() { # mac_go <prefix> → prints the GOROOT
  local want=$1 line v dir tgz sum
  line=$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' 2>/dev/null | python3 -I -c '
import json, sys
want = "go" + sys.argv[1]
for r in json.load(sys.stdin):
    if not r["stable"]: continue
    if r["version"] == want or r["version"].startswith(want + "."):
        for f in r["files"]:
            if f["os"] == "darwin" and f["arch"] == "arm64" and f["kind"] == "archive":
                print(r["version"][2:], f["sha256"]); sys.exit(0)' "$want" || true)
  v=${line%% *}; sum=${line#* }
  if [ -z "$line" ]; then
    v=$(ls "$out/toolchains" 2>/dev/null | grep "^go$want\(\.\|$\)" | sed 's/^go//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
  fi
  [ -n "$v" ] || { echo "ci-local: cannot resolve go $want (offline, nothing cached)" >&2; return 1; }
  dir="$out/toolchains/go$v"
  if [ ! -x "$dir/go/bin/go" ]; then
    tgz="$work/go$v.tar.gz"
    echo "ci-local: downloading go $v (darwin-arm64) from go.dev" >&2
    curl -fsSL -o "$tgz" "https://go.dev/dl/go$v.darwin-arm64.tar.gz" || return 1
    [ "$(shasum -a 256 "$tgz" | awk '{print $1}')" = "$sum" ] || { echo "ci-local: go $v checksum mismatch" >&2; return 1; }
    mkdir -p "$dir" && tar -xzf "$tgz" -C "$dir" && rm -f "$tgz"
  fi
  echo "$dir/go"
}

# test.yml › cv-visual. The job container only holds the docker CLI and the commit; the CV
# image is built and run on this Mac's engine through the socket, as linux/amd64.
job_cv_visual() {
  local c tag="aijobninja-cv-visual:ci-$run_id"
  c=$(start_container cv-visual "$IMG_DOCKER" "" -v /var/run/docker.sock:/var/run/docker.sock) || return
  # No git in this image and nothing in the CV suite calls git: files only.
  step "checkout (files)" seed_src "$c" none root || return
  # Tag differs from the workflow's (aijobninja-cv-visual) so this run's image can be labelled
  # and removed without touching anything else.
  step "Build the canonical CV rendering environment" dx_sh "$c" /src \
    "docker build --platform linux/amd64 --label '$label' --tag '$tag' tests/cv-visual" || return
  # The workflow bind-mounts \$PWD at /work; through the socket that would be a path on this
  # Mac, so the same files are streamed in instead. node_modules stays inside the container,
  # as the workflow's anonymous /work/node_modules volume does.
  step "Check every CV template and PDF page" dx_sh "$c" /src "
    tar -C /src -cf - . | docker run -i --rm --init --ipc=host --platform linux/amd64 \
      --label '$label' --network '$net' '$tag' \
      sh -c 'tar -xf - -C /work && npm install --ignore-scripts --package-lock=false && npm run test:cv-visual'" || return
  # "Upload CV visual diffs and rendered previews" (actions/upload-artifact): GitHub-only, skipped.
}

# test.yml › upgrade-gate (fetch-depth: 0: the harness needs release tags).
job_upgrade_gate() {
  local c
  c=$(start_container upgrade-gate "$IMG_NODE24" "" "${npm_cache[@]}" "${go_cache[@]}") || return
  step "provision: go 1.27, runner user" eval 'add_go "$c" && add_runner "$c" /cache/npm /cache/go' || return
  step "checkout (full history + tags)" seed_src "$c" full runner || return
  step "release tags in the checkout" dx "$c" runner /src "$LINUX_PATH" 'echo "$(git tag --list "aijobninja-v*" | wc -l) aijobninja-v* tags"; git tag --list "aijobninja-v*" | tail -3' || return
  step "npm install --ignore-scripts" dx "$c" runner /src "$LINUX_PATH" 'npm install --ignore-scripts' || return
  step "Upgrade PR gate (newest old release -> this commit)" dx "$c" runner /src "$LINUX_PATH" 'node upgrade-tests.mjs --pr-gate' || return
  step "Canary (harness must be able to fail)" dx "$c" runner /src "$LINUX_PATH" 'node upgrade-tests.mjs --canary' || return
  step "Local-paths declaration survives a real apply (#2421)" dx "$c" runner /src "$LINUX_PATH" 'node upgrade-tests.mjs --local-paths' || return
  step "User-layer manifest entry is refused, not fatal (#3782)" dx "$c" runner /src "$LINUX_PATH" 'node upgrade-tests.mjs --user-layer-refusal' || return
  step "Failed npm install is reported, rollback reinstalls" dx "$c" runner /src "$LINUX_PATH" 'node upgrade-tests.mjs --failed-install' || return
}

# web-ci.yml › web. linux/amd64: the browser suites launch Google Chrome (channel "chrome"),
# which GitHub's ubuntu-latest image ships and which exists for amd64 Linux only.
job_web() {
  local c
  c=$(start_container web "$IMG_NODE24" linux/amd64 "${npm_cache[@]}" --shm-size=1g \
    -v aijobninja-ci-apt-amd64-cache:/var/cache/apt/archives) || return
  step "provision: Google Chrome (as on ubuntu-latest), runner user" docker exec "$c" bash -eo pipefail -c '
    rm -f /etc/apt/apt.conf.d/docker-clean
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends google-chrome-stable >/dev/null
    google-chrome --version' || return
  add_runner "$c" /cache/npm || return
  step "checkout (depth 1)" seed_src "$c" 1 runner || return
  step "Install core dependencies" dx "$c" runner /src "$LINUX_PATH" 'npm install --ignore-scripts' || return
  step "npm ci" dx "$c" runner /src/web "$LINUX_PATH" 'npm ci' || return
  step "npm test" dx "$c" runner /src/web "$LINUX_PATH" 'npm test' || return
  step "npx tsc --noEmit" dx "$c" runner /src/web "$LINUX_PATH" 'npx tsc --noEmit' || return
  step "npm run build" dx "$c" runner /src/web "$LINUX_PATH" 'npm run build' || return
  step "Browser suites against the built app" dx "$c" runner /src/web "$LINUX_PATH" 'google-chrome --version
npm run test:browser' || return
}

# job-finder.yml › test
job_job_finder() {
  local c
  c=$(start_container job-finder "$IMG_PY" "") || return
  step "provision: bun (latest), runner user" sh -c "
    docker run --rm --label '$label' '$IMG_BUN' cat /usr/local/bin/bun |
      docker exec -i '$c' sh -c 'cat > /usr/local/bin/bun && chmod 755 /usr/local/bin/bun && bun --version'" || return
  add_runner "$c" || return
  step "checkout (depth 1)" seed_src "$c" 1 runner || return
  step "Python tests and guards" dx "$c" runner /src/modules/job-finder "$LINUX_PATH" 'python3 --version
python3 -m unittest discover -s tests
python3 tools/security_guards.py' || return
  step "Web UI tests" dx "$c" runner /src/modules/job-finder/webui "$LINUX_PATH" 'bun test' || return
}

# plugin-registry-validate.yml › validate
job_plugin_registry() {
  local c
  c=$(start_container plugin-registry "$IMG_NODE24" "") || return
  add_runner "$c" || return
  step "checkout (full history)" seed_src "$c" full runner || return
  step "Validate registry shape" dx "$c" runner /src "$LINUX_PATH" 'node validate-plugin-registry.mjs' || return
  step "Clone + audit each registry entry" dx "$c" runner /src "$LINUX_PATH" 'node validate-plugin-registry.mjs --deep' || return
  [ -n "$base_sha" ] || { echo "no origin/main in this clone: cannot run 'One plugin per PR'"; return 1; }
  # The workflow's script, with BASE_REF=main. Its `git fetch origin "$BASE_REF"` is replaced
  # by the runner putting this clone's origin/main into the checkout (no network fetch).
  step "One plugin per PR (vs origin/main ${base_sha:0:12})" dx "$c" runner /src "$LINUX_PATH" '
    BASE_REF=main
    if git diff --name-only --diff-filter=D "origin/$BASE_REF"...HEAD -- plugins-registry.json | grep -q .; then
      echo "Migration PR (removes legacy plugins-registry.json) — one-plugin-per-PR gate not applicable."
      exit 0
    fi
    CHANGED=$(git diff --name-only "origin/$BASE_REF"...HEAD -- "plugins-registry/*.json" plugins-registry.json | wc -l)
    echo "registry files changed vs origin/$BASE_REF: $CHANGED"
    if [ "$CHANGED" -gt 1 ]; then echo "A registry PR may add or bump exactly one plugins-registry/<id>.json file"; exit 1; fi' || return
}

# no-user-data.yml › guard. The check is a filter over the PR's changed files; the PR API only
# supplies that list. Here the list is `git diff --name-status origin/main...<commit>` and the
# filter is the workflow's own script, read from the commit under test at run time.
no_user_data_harness() {
  cat <<'EOF'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const wf = readFileSync('.github/workflows/no-user-data.yml', 'utf8').split('\n');
const at = wf.findIndex((l) => /^\s+script:\s*\|\s*$/.test(l));
if (at < 0) { console.error('no `script: |` block in no-user-data.yml'); process.exit(1); }
const indent = (l) => l.match(/^ */)[0].length;
const keyIndent = indent(wf[at]);
const body = [];
for (const l of wf.slice(at + 1)) {
  if (l.trim() && indent(l) <= keyIndent) break;
  body.push(l);
}
const pad = Math.min(...body.filter((l) => l.trim()).map(indent));
const script = body.map((l) => l.slice(pad)).join('\n');
const STATUS = { A: 'added', M: 'modified', D: 'removed', T: 'changed', C: 'copied', R: 'renamed' };
const raw = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', 'origin/main...HEAD'], { encoding: 'utf8' });
const parts = raw.split('\0').filter(Boolean);
const files = [];
for (let i = 0; i < parts.length; i += 2) files.push({ status: STATUS[parts[i][0]] || 'modified', filename: parts[i + 1] });
console.log(`changed files vs merge-base with origin/main: ${files.length}`);
const github = { rest: { pulls: { listFiles: 'listFiles' } }, paginate: async () => files };
const context = { repo: { owner: 'mannysinghx', repo: 'AIJOBNINJA' }, payload: { pull_request: { number: 0 } } };
const core = {
  setFailed: (m) => { console.error(`::error::${m}`); process.exitCode = 1; },
  info: (m) => console.log(m),
};
const AsyncFunction = (async () => {}).constructor;
await new AsyncFunction('github', 'context', 'core', script)(github, context, core);
EOF
}
job_no_user_data() {
  local c
  [ -n "$base_sha" ] || { echo "no origin/main in this clone: nothing to compare against"; return 1; }
  c=$(start_container no-user-data "$IMG_NODE24" "") || return
  add_runner "$c" || return
  step "checkout (full history)" seed_src "$c" full runner || return
  no_user_data_harness | docker exec -i "$c" sh -c 'mkdir -p /ci && cat > /ci/no-user-data.mjs' || return
  step "guard (vs origin/main ${base_sha:0:12})" dx "$c" runner /src "$LINUX_PATH" 'node /ci/no-user-data.mjs' || return
}

# ---------------------------------------------------------------- results

# One line of counts per job, read from its log.
counts_of() { # counts_of <job> <log>
  local j=$1 plain="$work/$1.plain" s="" t p f r ok fl
  sed -e $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$2" > "$plain"
  case "$j" in
    test-linux|test-macos)
      s=$(sed -n 's/^📊 Results: \(.*\)$/test-all: \1/p' "$plain" | tail -1)
      if grep -q '^::ci-local step \[go test' "$plain"; then
        ok=$(sed -n '/^::ci-local step \[go test/,$p' "$plain" | grep -cE '^ok[[:space:]]' || true)
        fl=$(sed -n '/^::ci-local step \[go test/,$p' "$plain" | grep -cE '^FAIL[[:space:]]' || true)
        s="$s; go: $ok packages ok, $fl failed"
      fi ;;
    web)
      t=$(sed -n 's/^ℹ tests \([0-9]*\)$/\1/p' "$plain" | head -1)
      p=$(sed -n 's/^ℹ pass \([0-9]*\)$/\1/p' "$plain" | head -1)
      f=$(sed -n 's/^ℹ fail \([0-9]*\)$/\1/p' "$plain" | head -1)
      ok=$(sed -n 's/^ℹ skipped \([0-9]*\)$/\1/p' "$plain" | head -1)
      [ -z "$t" ] || s="npm test: $t tests, $p pass, $f fail, $ok skipped"
      r=$(grep -E '[0-9]+ browser suites ran|[0-9]+ of [0-9]+ browser suites failed' "$plain" | tail -1 | sed 's/^[^0-9]*//')
      [ -z "$r" ] || s="$s; browser: $r"
      r=$(grep -E 'on the first run, passed on the second' "$plain" | sed 's/^ *//;s/:.*//' | paste -sd ',' -)
      [ -z "$r" ] || s="$s; passed on retry: $r" ;;
    job-finder)
      t=$(grep -E '^Ran [0-9]+ tests? in ' "$plain" | tail -1 | sed 's/ in .*//')
      r=$(grep -E '^(OK|FAILED)( |$)' "$plain" | tail -1)
      [ -z "$t" ] || s="unittest: $t, $r"
      p=$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$plain" | tail -1)
      f=$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$plain" | tail -1)
      [ -z "$p" ] || s="$s; bun: $p pass, ${f:-0} fail" ;;
    cv-visual)
      s=$(grep -E '^ *[0-9]+ (passed|failed|flaky|skipped)' "$plain" | sed 's/^ *//;s/ (.*//' | paste -sd ',' - | sed 's/,/, /g')
      [ -z "$s" ] || s="playwright: $s" ;;
    upgrade-gate)
      s=$(grep -E '^[0-9]+ aijobninja-v' "$plain" | tail -1) ;;
    plugin-registry)
      s=$(grep -E 'plugin registry is valid|^registry files changed' "$plain" | sed 's/^[^a-z]* //' | paste -sd ';' - | sed 's/;/; /g') ;;
    no-user-data)
      s=$(grep -E '^changed files vs' "$plain" | tail -1) ;;
  esac
  r=$(sed -n 's/^::ci-local step \[\(.*\)\] FAILED.*/\1/p' "$plain" | tail -1)
  [ -z "$r" ] || s="${s:+$s; }failed step: $r"
  grep -q '^::ci-local TIMEOUT' "$plain" && s="${s:+$s; }TIMEOUT"
  printf '%s' "$s"
}

fmt_dur() { printf '%dm%02ds' $(( $1 / 60 )) $(( $1 % 60 )); }

# Hang guard per job: twice the workflow's timeout-minutes (none set = 90 minutes). This Mac
# is shared with other work, so the workflow's own limits would fail slow-but-fine runs.
limit_of() {
  case "$1" in
    test-linux|test-macos) echo 60 ;;
    cv-visual|upgrade-gate|job-finder) echo 40 ;;
    *) echo 90 ;;
  esac
}

run_job() { # run_job <job>: runs in a background subshell, stdout/stderr = the job log
  local j=$1 fn s rc=0
  fn="job_$(echo "$j" | tr '-' '_')"
  s=$(date +%s)
  echo "::ci-local job $j commit $sha run $run_id start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  set +e
  "$fn"
  rc=$?
  set -e
  local dur=$(( $(date +%s) - s ))
  if [ $rc -eq 0 ]; then echo "::ci-local job $j PASS $(fmt_dur $dur)"; else echo "::ci-local job $j FAIL (exit $rc) $(fmt_dur $dur)"; fi
  { echo "rc=$rc"; echo "dur=$dur"; } > "$work/$j.result"
  # The job's container goes as soon as the job ends, so the next one has the room.
  [ "$keep" = 1 ] || docker rm -f -v "aijobninja-ci-$run_id-$j" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------- main

if [ "$needs_docker" = 1 ]; then
  echo "ci-local: pulling images"
  for j in $jobs; do
    case "$j" in
      test-linux) pull "$IMG_NODE24"; pull "$IMG_NODE22"; pull "$IMG_GO" ;;
      upgrade-gate) pull "$IMG_NODE24"; pull "$IMG_GO" ;;
      web) pull "$IMG_NODE24" linux/amd64 ;;
      job-finder) pull "$IMG_PY"; pull "$IMG_BUN" ;;
      cv-visual) pull "$IMG_DOCKER" ;;
      plugin-registry|no-user-data) pull "$IMG_NODE24" ;;
    esac
  done
  docker network create --label "$label" "$net" >/dev/null
fi

launched=""
finished=""
report_finished() {
  local j r
  for j in $launched; do
    case " $finished " in *" $j "*) continue ;; esac
    [ -f "$work/$j.result" ] || continue
    finished="$finished $j"
    r=$(sed -n 's/^rc=//p' "$work/$j.result")
    echo "ci-local: $(ts) ■ $j $([ "$r" = 0 ] && echo PASS || echo FAIL) ($(fmt_dur "$(sed -n 's/^dur=//p' "$work/$j.result")"))"
  done
}
running_count() {
  local n=0 j
  for j in $launched; do [ -f "$work/$j.result" ] || n=$((n + 1)); done
  echo $n
}
# Ends a job that ran past its limit: its container and every process under its subshell.
enforce_limits() {
  local j s
  for j in $launched; do
    [ ! -f "$work/$j.result" ] || continue
    s=$(sed -n 's/^start=//p' "$work/$j.start")
    [ $(( $(date +%s) - s )) -ge $(( $(limit_of "$j") * 60 )) ] || continue
    echo "::ci-local TIMEOUT: $j ran past $(limit_of "$j") minutes" >> "$out/$sha.$j.log"
    docker kill "aijobninja-ci-$run_id-$j" >/dev/null 2>&1 || true
    kill_tree "$(sed -n 's/^pid=//p' "$work/$j.start")"
    { echo "rc=124"; echo "dur=$(( $(date +%s) - s ))"; } > "$work/$j.result"
  done
}
tick() { sleep 3; enforce_limits; report_finished; }

for j in $jobs; do
  while [ "$(running_count)" -ge "$MAX_PARALLEL" ]; do tick; done
  log="$out/$sha.$j.log"
  echo "ci-local: $(ts) ▶ $j"
  ( run_job "$j" ) > "$log" 2>&1 &
  pids+=($!)
  { echo "pid=$!"; echo "start=$(date +%s)"; } > "$work/$j.start"
  launched="$launched $j"
done
while [ "$(running_count)" -gt 0 ]; do tick; done
wait || true
report_finished

# Summary
total=$(( $(date +%s) - t0 ))
all_ok=1
rows=""
for j in $jobs; do
  log="$out/$sha.$j.log"
  if [ -f "$work/$j.result" ]; then
    r=$(sed -n 's/^rc=//p' "$work/$j.result"); d=$(sed -n 's/^dur=//p' "$work/$j.result")
  else r=1; d=0; fi
  [ "$r" = 0 ] && res=PASS || { res=FAIL; all_ok=0; }
  c=$(counts_of "$j" "$log")
  rows="$rows$j|$res|$(fmt_dur "$d")|$c"$'\n'
done

not_run="test (windows-latest)|NOT REPRODUCIBLE|-|test.yml matrix leg: Windows cannot run on a Mac
codeql|NOT REPRODUCED|-|codeql.yml: GitHub's CodeQL service, no faithful local equivalent
dependency-review|NOT REPRODUCED|-|dependency-review.yml: GitHub's dependency-review service"

echo
echo "ci-local summary — $sha — $(fmt_dur "$total") wall"
printf '%s%s\n' "$rows" "$not_run" | awk -F'|' '{ printf "  %-22s %-17s %-8s %s\n", $1, $2, $3, $4 }'
echo "  logs: $out/$sha.<job>.log"

if [ "$all_ok" = 1 ] && [ -z "$only" ]; then
  {
    echo "commit=$sha"
    echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "started=$started_utc"
    echo "runner=scripts/ci-local.sh run $run_id"
    printf '%s' "$rows" | awk -F'|' '{ printf "job %s=%s %s; %s\n", $1, $2, $3, $4 }'
    printf '%s\n' "$not_run" | awk -F'|' '{ printf "not-run %s=%s\n", $1, $4 }'
  } > "$out/$sha.pass"
  echo "ci-local: PASS — recorded $out/$sha.pass"
  exit 0
fi
if [ "$all_ok" = 1 ]; then
  echo "ci-local: PASS (--only: no pass record)"
  exit 0
fi
rm -f "$out/$sha.pass"
echo "ci-local: FAIL" >&2
exit 1
