#!/bin/sh
# Replay with a locally built box image containing the matching webapp host.
set -eu
if [ "$#" != 2 ]; then
  echo "Usage: $0 <local Foundry box image> <new output directory>" >&2
  exit 2
fi
planning_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(CDPATH= cd -- "$planning_dir/../.." && pwd)
image=$1
out=$2
mkdir -- "$out"
out=$(CDPATH= cd -- "$out" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir "$tmp/package" "$tmp/native-apple" "$tmp/charts"
cp "$planning_dir/fixtures/native-apple.md" "$tmp/native-apple/README.md"
cp "$planning_dir/fixtures/charts.md" "$tmp/charts/README.md"
mkdir -p "$tmp/native-apple/.forgejo/ISSUE_TEMPLATE"
cp "$planning_dir/fixtures/feature-template.md" "$tmp/native-apple/.forgejo/ISSUE_TEMPLATE/feature.md"
cp "$planning_dir/fixtures/bug-template.md" "$tmp/native-apple/.forgejo/ISSUE_TEMPLATE/bug.md"
for repository in native-apple charts; do
  git -C "$tmp/$repository" init -q -b main
  git -C "$tmp/$repository" add .
  GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
    git -C "$tmp/$repository" -c user.name='Synthetic fixture' -c user.email='fixture@example.test' \
    commit -qm "Seed synthetic Keystone $repository"
done
for name in software-foundry planning forerunner wiki; do
  source_dir="$app_dir/../$name"
  slug=$name
  if [ "$name" = wiki ]; then slug=wiki-map; fi
  mkdir "$tmp/package/$slug"
  (
    cd "$source_dir"
    ASTRO_TELEMETRY_DISABLED=1 npm exec --offline -- outfitter-app-build --mode operational --output "$tmp/package/$slug/package.json"
  )
  cp "$source_dir/graph/schema.graphql" "$source_dir/graph/documents.json" "$tmp/package/$slug/"
done
chmod a+rx "$tmp" "$tmp/package"
podman run --rm --pull=never --network none --add-host outfitter.localhost:127.0.0.1 \
  --add-host software-foundry.box.outfitter.localhost:127.0.0.1 \
  --userns=keep-id:uid=1000,gid=1000 \
  -v "$app_dir/../../box/supervisor.mjs:/app/.box/box/supervisor.mjs:ro" \
  -v "$planning_dir:/eval:ro" -v "$tmp/package:/package:ro" \
  -v "$tmp/native-apple:/in/repo:ro" -v "$tmp/charts:/in/charts:ro" \
  -v "$out:/out" "$image" node /eval/boot.mjs
