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
mkdir -p "$tmp/package" "$tmp/repos/native-apple" "$tmp/repos/charts" "$tmp/repos/os" "$tmp/repos/services"
cp "$planning_dir/fixtures/native-apple.md" "$tmp/repos/native-apple/README.md"
cp "$planning_dir/fixtures/charts.md" "$tmp/repos/charts/README.md"
mkdir -p "$tmp/repos/native-apple/.forgejo/ISSUE_TEMPLATE"
cp "$planning_dir/fixtures/feature-template.md" "$tmp/repos/native-apple/.forgejo/ISSUE_TEMPLATE/feature.md"
cp "$planning_dir/fixtures/bug-template.md" "$tmp/repos/native-apple/.forgejo/ISSUE_TEMPLATE/bug.md"
printf '%s\n' '# KEYSTONE_OS_FIXTURE' 'Synthetic operating-system configuration notes.' > "$tmp/repos/os/README.md"
printf '%s\n' '# KEYSTONE_SERVICES_FIXTURE' 'Synthetic service configuration notes.' > "$tmp/repos/services/README.md"
for repository in native-apple charts os services; do
  git -C "$tmp/repos/$repository" init -q -b main
  git -C "$tmp/repos/$repository" add .
  GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
    git -C "$tmp/repos/$repository" -c user.name='Synthetic fixture' -c user.email='fixture@example.test' \
    commit -qm "Seed synthetic Keystone $repository"
done
(
  cd "$app_dir"
  ASTRO_TELEMETRY_DISABLED=1 npm exec --offline -- outfitter-app-build --mode operational --output "$tmp/package/software-foundry.operational.json"
)
cp "$app_dir/graph/"schema.graphql "$app_dir/graph/"documents.json "$tmp/package/"
chmod a+rx "$tmp" "$tmp/package"
podman run --rm --pull=never --network none --add-host outfitter.localhost:127.0.0.1 \
  --add-host software-foundry.box.outfitter.localhost:127.0.0.1 \
  --userns=keep-id:uid=1000,gid=1000 \
  -v "$planning_dir:/eval:ro" -v "$tmp/package:/package:ro" \
  -e FOUNDRY_DOTTED_REPOSITORIES="${FOUNDRY_DOTTED_REPOSITORIES:-0}" \
  -v "$tmp/repos/native-apple:/in/repo:ro" -v "$tmp/repos:/in/planning:ro" \
  -v "$out:/out" "$image" node /eval/boot.mjs
