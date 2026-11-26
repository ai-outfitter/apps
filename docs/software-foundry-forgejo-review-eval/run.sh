#!/bin/sh
set -eu
pins=
if [ "${1:-}" = --pins ]; then
  test "$#" -ge 2
  pins=$(realpath -- "$2")
  shift 2
fi
if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "Usage: $0 [--pins <launch-pins.json>] <local-box-image> <case> <fresh-private-output> <operational-package-dir> [legacy-gateway-file]" >&2
  exit 2
fi
case "$2" in native|grants|grants-revoked|refusal|happy|slash-base|before-work|before-open|before-review|before-review-base|race-lost|provider-fenced|mixed-gateway|draft-read-refusal|review-not-sent|authority-retry) ;;
  *) echo "Unknown case: $2" >&2; exit 2 ;;
esac
umask 077
eval_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
parent=$(CDPATH= cd -- "$(dirname -- "$3")" && pwd)
if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Keep output outside Git worktrees" >&2
  exit 2
fi
out="$parent/$(basename -- "$3")"
case_name=$2
image_ref=$1
package_arg=$4
if [ "$case_name" = mixed-gateway ] && [ "$#" -eq 5 ]; then
  old_gateway=$(realpath -- "$5")
  expected=ef07cab796bd9ce50b92d6661fba385997c64f1518df67b3e2c760b26feb4d92
  test "$(sha256sum < "$old_gateway" | cut -d ' ' -f 1)" = "$expected"
elif [ "$case_name" != mixed-gateway ] && [ "$#" -eq 4 ]; then
  old_gateway=
else
  echo "Only mixed-gateway requires the pinned legacy gateway file." >&2
  exit 2
fi
package=$(CDPATH= cd -- "$package_arg" && pwd)
test "$(podman info --format '{{.Host.Security.Rootless}}')" = true
image=$(podman image inspect "$image_ref" --format '{{.Id}}')
for file in software-foundry.operational.json schema.graphql documents.json apps-tree.txt; do
  test -s "$package/$file"
done
mkdir -- "$out"
stage=$(mktemp -d /tmp/forgejo-review.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
mkdir "$stage/repo"
planwork="$eval_dir/../software-foundry-planwork-eval-284"
if [ -n "$pins" ]; then
  mkdir "$stage/package" "$stage/planwork"
  cp "$pins" "$stage/pins.json"
  cp -R "$eval_dir" "$stage/eval"
  cp "$planwork/mcp.mjs" "$planwork/pins.json" "$stage/planwork"
  for file in software-foundry.operational.json schema.graphql documents.json apps-tree.txt; do
    cp "$package/$file" "$stage/package/$file"
  done
  eval_dir="$stage/eval"
  planwork="$stage/planwork"
  package="$stage/package"
fi
set --
if [ -n "$old_gateway" ]; then
  cp "$old_gateway" "$stage/legacy-gateway.mjs"
  test "$(sha256sum < "$stage/legacy-gateway.mjs" | cut -d ' ' -f 1)" = "$expected"
  set -- -v "$stage/legacy-gateway.mjs:/app/workspace/gateway.mjs:ro"
fi
"$eval_dir/seed-git.sh" "$stage/repo" > "$out/base.sha"
if [ "$case_name" = slash-base ]; then
  git -C "$stage/repo" -c core.hooksPath=/dev/null branch release/review-fixture
fi
podman image inspect "$image" --format '{{.Id}} {{index .Config.Labels "io.outfitter.webapp.tree"}} {{index .Config.Labels "io.outfitter.apps.tree"}}' > "$out/image.txt"
(cd "$package" && sha256sum software-foundry.operational.json schema.graphql documents.json apps-tree.txt) > "$out/package.sha256"
cp "$package/apps-tree.txt" "$out/apps-tree.txt"
if [ -n "$pins" ]; then
  podman image inspect "$image" --format '{{index .Config.Labels "io.outfitter.webapp.commit"}}' > "$out/webapp-commit.txt"
  node "$eval_dir/check-launch.mjs" "$stage" "$out" "$case_name"
fi
podman run --rm --pull=never --network none --add-host outfitter.localhost:127.0.0.1 \
  --add-host box.outfitter.localhost:127.0.0.1 --add-host software-foundry.box.outfitter.localhost:127.0.0.1 \
  --userns=keep-id:uid=1000,gid=1000 -e "FOUNDRY_REVIEW_CASE=$case_name" \
  -v "$eval_dir:/eval:ro" -v "$planwork:/planwork:ro" \
  -v "$package:/package:ro" -v "$stage/repo:/in/repo:ro" -v "$out:/out" \
  "$@" "$image" node /eval/bootstrap.mjs > "$out/box.log" 2>&1 || {
    status=$?
    echo "$case_name failed. See $out/box.log and any recorded report.json." >&2
    exit "$status"
  }
node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
  assert.equal(result.case, process.argv[2], "Result must identify the requested case");
  assert.equal(result.outcome, "pass", result.error);
  console.log(`${result.case}: pass (${process.argv[1]})`);
' "$out/report.json" "$case_name"
