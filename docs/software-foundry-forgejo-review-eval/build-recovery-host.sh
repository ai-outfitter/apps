#!/usr/bin/env bash
# Layer the selected Webapp Git snapshot and its pinned connector on the local eval box.
set -euo pipefail
if [[ $# != 4 ]]; then
  echo "Usage: $0 <webapp-repo> <webapp-ref> <new-image-tag> <fresh-private-build-dir>" >&2
  exit 2
fi
umask 077
runner=$(cd -- "$(dirname -- "$0")" && pwd)
apps=$(git -C "$runner" rev-parse --show-toplevel)
webapp=$(git -C "$1" rev-parse --show-toplevel)
commit=$(git -C "$webapp" rev-parse --verify --end-of-options "$2^{commit}")
tree=$(git -C "$webapp" rev-parse "$commit^{tree}")
parent=$(cd -- "$(dirname -- "$4")" && pwd)
if git -C "$parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Keep build output outside Git worktrees" >&2
  exit 2
fi
out="$parent/$(basename -- "$4")"
base=ddd173210ad87a95a39ccfe80944e77d2cc9a07b01415d93d75225245825a0d7
base_commit=9c3c3e6a6c7eda6151501e7e1e3df0b240ac53ce
connector=093f07d9042545a345282407b54798a203b83590
podman image inspect "$base" >/dev/null
[[ "$(git -C "$webapp" show "$commit:package.json")" == *"ai-outfitter/apps#$connector::path:packages/connector-forgejo"* ]]
mkdir -- "$out"
mkdir "$out/overlay" "$out/connector"
git -C "$webapp" diff --name-only --diff-filter=ACMRT -z "$base_commit" "$commit" > "$out/overlay-paths"
mapfile -d '' -t paths < "$out/overlay-paths"
git -C "$webapp" archive "$commit" -- "${paths[@]}" | tar -x -C "$out/overlay"
git -C "$apps" archive "$connector:packages/connector-forgejo" | tar -x -C "$out/connector"
# Source from Git may be extracted with restrictive directory modes.
chmod -R a+rX "$out/overlay" "$out/connector"
cat > "$out/Containerfile" <<'INNER'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
COPY --chown=node:node overlay/ /app/
COPY connector/ /tmp/forgejo-connector/
RUN for file in /app/workspace/runtime/*.mjs; do install -m 0644 "$file" "/opt/workspace/${file##*/}"; done && \
  rm -rf /app/packages/connector-forgejo /app/node_modules/@ai-outfitter/connector-forgejo && \
  mkdir -p /app/node_modules/@ai-outfitter/connector-forgejo && \
  cp -a /tmp/forgejo-connector/. /app/node_modules/@ai-outfitter/connector-forgejo/ && \
  rm -rf /tmp/forgejo-connector && chown -R node:node /app/src/generated/apps
USER node
INNER
podman build --network=none --pull=never --label "io.outfitter.webapp.tree=$tree" \
  --label "io.outfitter.webapp.commit=$commit" --build-arg "BASE_IMAGE=$base" \
  -t "$3" "$out" > "$out/build.log" 2>&1
podman image inspect "$3" --format '{{.Id}}' > "$out/image-id.txt"
