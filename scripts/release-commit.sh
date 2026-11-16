#!/usr/bin/env bash
# Publishes one release of the plugin to the public repo's default branch.
#
#   scripts/release-commit.sh <version> <remote-url> <claudecode|chatgpt|npm>
#
# Run at the root of the mirrored tree (this directory's parent is the repo root there), after
# `npm run build`. It makes a commit whose tree is HEAD's tracked files plus what the build wrote
# for the given target — bundle, notices, and skills or licence copy, all git-ignored and therefore
# added explicitly — with the remote's
# current `main` as parent, and pushes it as `main` together with the tag v<version> in one atomic
# push. `main` therefore only ever fast-forwards and never exists without a bundle.
#
# It refuses — pushing nothing — when the version disagrees with the manifests, when the bundle is
# missing, when the remote cannot be reached, or when that version is already published.
set -euo pipefail

die() { echo "release-commit: $*" >&2; exit 1; }

[ $# -eq 3 ] || die "usage: release-commit.sh <version> <remote-url> <claudecode|chatgpt|npm>"
VERSION="$1"
REMOTE="$2"
TARGET="$3"
# Each target is one packaging folder with its own manifest (see scripts/targets.mjs).
# EXTRA: what the build writes for this target besides dist/ and the notices — the plugins get a
# copy of the skills, the npm package its own copy of the licence.
case "$TARGET" in
  claudecode) DIR=plugin;         MANIFEST=plugin/.claude-plugin/plugin.json;        EXTRA=skills ;;
  chatgpt)    DIR=plugin-chatgpt; MANIFEST=plugin-chatgpt/.codex-plugin/plugin.json; EXTRA=skills ;;
  npm)        DIR=npm;            MANIFEST=npm/package.json;                         EXTRA=LICENSE ;;
  *) die "unknown target '$TARGET' (claudecode, chatgpt or npm)" ;;
esac
# What must exist after a build, and what goes into the release on top of the tracked files:
# everything the build wrote for this target.
REQUIRED=("$DIR/dist/index.js" "$DIR/dist/preview-worker.mjs" "$DIR/THIRD-PARTY-NOTICES.txt")
OUTPUTS=("$DIR/dist" "$DIR/$EXTRA" "$DIR/THIRD-PARTY-NOTICES.txt")
# -c credential.helper= : never let a helper store a token that is part of the remote URL.
GIT=(git -c credential.helper=)

cd "$(git rev-parse --show-toplevel)"

version_of() { node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" "$1"; }
[ -f "$MANIFEST" ] || die "this tree has no $TARGET target ($MANIFEST)"
PLUGIN_VERSION="$(version_of "$MANIFEST")"
PACKAGE_VERSION="$(version_of package.json)"
if [ "$VERSION" != "$PLUGIN_VERSION" ] || [ "$VERSION" != "$PACKAGE_VERSION" ]; then
  die "version mismatch (tag $VERSION, ${MANIFEST##*/} $PLUGIN_VERSION, package.json $PACKAGE_VERSION)"
fi

for f in "${REQUIRED[@]}"; do
  [ -s "$f" ] || die "bundle missing — run npm run build ($f)"
done
[ -e "$DIR/$EXTRA" ] || die "bundle missing — run npm run build ($DIR/$EXTRA)"

# Asked once, up front: a failed ls-remote must not read as "nothing published yet".
REFS="$("${GIT[@]}" ls-remote "$REMOTE" "refs/tags/v$VERSION" refs/heads/main 2>/dev/null)" \
  || die "cannot reach the remote"
if grep -q "refs/tags/v$VERSION\$" <<<"$REFS"; then
  die "v$VERSION is already published — bump the version"
fi

SOURCE="$(git rev-parse HEAD)"

# A throwaway index: the checkout's own index and working tree stay exactly as they are.
INDEX="$(mktemp)"
trap 'rm -f "$INDEX"' EXIT
export GIT_INDEX_FILE="$INDEX"
git read-tree HEAD
git add -f -- "${OUTPUTS[@]}"
TREE="$(git write-tree)"
unset GIT_INDEX_FILE

PARENT=()
if grep -q 'refs/heads/main$' <<<"$REFS"; then
  "${GIT[@]}" fetch --quiet --no-tags "$REMOTE" refs/heads/main
  PARENT=(-p "$(git rev-parse FETCH_HEAD)")
fi

WHO='github-actions[bot]'
MAIL='41898282+github-actions[bot]@users.noreply.github.com'
COMMIT="$(GIT_AUTHOR_NAME="$WHO" GIT_AUTHOR_EMAIL="$MAIL" GIT_COMMITTER_NAME="$WHO" GIT_COMMITTER_EMAIL="$MAIL" \
  git commit-tree "$TREE" ${PARENT[@]+"${PARENT[@]}"} -m "Release v$VERSION" -m "Source: $SOURCE (branch source)")"

"${GIT[@]}" push --quiet --atomic "$REMOTE" "$COMMIT:refs/heads/main" "$COMMIT:refs/tags/v$VERSION"
echo "release-commit: published v$VERSION as $COMMIT"
