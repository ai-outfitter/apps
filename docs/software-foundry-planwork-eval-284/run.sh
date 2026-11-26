#!/bin/sh
set -eu
if [ "$#" -ne 4 ]; then
  echo "Usage: $0 <local-pinned-image> <legacy|short|cancel|uncertainty|delayed|interrupted> <fresh-private-output-directory> <package-directory>" >&2
  exit 2
fi
umask 077
runner=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=$1
arm=$2
case "$arm" in legacy|short|cancel|uncertainty|delayed|interrupted) ;; *) echo "Select an offline case" >&2; exit 2 ;; esac
parent=$(CDPATH= cd -- "$(dirname -- "$3")" && pwd)
if env -i PATH="$PATH" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Place replay output outside Git worktrees" >&2
  exit 2
fi
out="$parent/$(basename -- "$3")"
package=$(CDPATH= cd -- "$4" && pwd)
test "$(podman info --format '{{.Host.Security.Rootless}}')" = true
identities=$(podman image inspect "$image" --format '{{.Id}} {{index .Config.Labels "io.outfitter.webapp.tree"}} {{index .Config.Labels "io.outfitter.apps.tree"}}')
# Inspect all identities together and launch the verified image ID.
set -f
set -- $identities
test "$#" -eq 3
node "$runner/package-check.mjs" "$package" "$@"
image_id=$1
mkdir -- "$out"
stage=$(mktemp -d /tmp/planwork.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
mkdir "$stage/repos"
"$runner/seed-git.sh" "$runner/fixtures" "$stage/repos" >"$out/repositories.txt"
diff -u "$runner/fixtures/repositories.txt" "$out/repositories.txt"
printf '%s\n' "$identities" >"$out/image.txt"
cp "$package/apps-tree.txt" "$out/apps-tree.txt"
(cd "$runner/fixtures" && sha256sum scenario.json charts.md native-apple.md legacy-cases.json collection-cases.json repositories.txt) >"$out/fixtures.sha256"
(cd "$package" && sha256sum software-foundry.operational.json schema.graphql documents.json) >"$out/package.sha256"
box_exit=0
podman run --rm --pull=never --network none --add-host outfitter.localhost:127.0.0.1 \
  --add-host software-foundry.box.outfitter.localhost:127.0.0.1 \
  --userns=keep-id:uid=1000,gid=1000 -e "PLANWORK_ARM=$arm" \
  -v "$runner:/eval:ro" -v "$package:/package:ro" \
  -v "$stage/repos/native-apple:/in/repo:ro" -v "$stage/repos:/in/planning:ro" \
  -v "$out:/out" "$image_id" node /eval/bootstrap.mjs >"$out/box.log" 2>&1 || box_exit=$?
node "$runner/grade.mjs" "$out" "$arm" "$box_exit"
