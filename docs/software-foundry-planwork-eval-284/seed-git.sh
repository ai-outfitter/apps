#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <fixture-directory> <empty-repository-parent>" >&2
  exit 2
fi
fixtures=$1
parent=$2
fixture_git() {
  env -i PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_ATTR_NOSYSTEM=1 GIT_AUTHOR_NAME='Synthetic fixture' GIT_AUTHOR_EMAIL=fixture@example.test \
    GIT_COMMITTER_NAME='Synthetic fixture' GIT_COMMITTER_EMAIL=fixture@example.test \
    GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
    git -c core.attributesFile=/dev/null -c core.autocrlf=false -c commit.gpgsign=false "$@"
}
for repo in charts native-apple; do
  directory="$parent/$repo"
  mkdir "$directory"
  cp "$fixtures/$repo.md" "$directory/README.md"
  fixture_git -C "$directory" init -q -b main --object-format=sha1 --template=
  fixture_git -C "$directory" add -- README.md
  tree=$(fixture_git -C "$directory" write-tree)
  commit=$(fixture_git -C "$directory" commit-tree "$tree" --no-gpg-sign -m "Seed synthetic $repo")
  fixture_git -C "$directory" update-ref refs/heads/main "$commit"
  printf '%s %s\n' "$repo" "$commit"
done
