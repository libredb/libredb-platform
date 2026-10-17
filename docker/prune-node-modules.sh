#!/bin/sh
# Deletes the files of installed node_modules trees that no package loads at run time. The Dockerfile runs it on the
# migrator's tree (stage migrator-deps, after generate) and on the standalone server's traced tree (stage builder):
#   - TypeScript files, declarations included: under Node's default conditions no package entry point resolves to one;
#   - source maps, which Node reads only with --enable-source-maps, and the image never enables it;
#   - test files, the test, docs and example directories at a package's root, and the test-utils directories at any
#     depth of a package, such as @prisma/get-platform's dist/test-utils, but not a package named test-utils;
#   - markdown, except license and notice texts, which the licenses require to travel with the code;
#   - with --prisma-schema, the Prisma query compilers (query_compiler_<variant>_bg.<provider>.*) of every database
#     provider but the one the schema's datasource names. A tree with compilers but none for that provider fails the
#     build, so a provider change cannot ship an image without its compiler;
#   - the sharp builds (@img/sharp-<platform>, @img/sharp-libvips-<platform>) for the libc the image does not use. The
#     builder stage runs on the runner's base image, so its libc is the runner's; a tree with sharp but without the
#     builds for that libc fails the build;
#   - with --prisma-cli, which only the migrator's tree takes, the paths that its list deletes
#     (docker/migrator/prisma-cli-prune.txt): the files of the Prisma CLI's dependencies that the image's commands
#     never open. A path the list deletes that matches nothing, or a path it keeps that is missing afterwards, fails
#     the build, so a list that no longer fits the installed Prisma cannot ship an image.
# scripts/ci/docker-smoke.sh fails when the runner image still holds any of them.
set -eu

# Node's glibc build reports the glibc version it runs on and a musl build reports none, which is how sharp tells them
# apart when it loads.
if node -e 'process.exit(process.report.getReport().header.glibcVersionRuntime ? 0 : 1)'; then
  libc=linux other_libc=linuxmusl
else
  libc=linuxmusl other_libc=linux
fi

provider=
if [ "${1-}" = --prisma-schema ]; then
  provider=$(sed -n '/^datasource /,/^}/ s/^[[:space:]]*provider[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$2")
  case $provider in
    '' | *[!a-z0-9]*)
      echo "prune-node-modules: $2 names no single datasource provider" >&2
      exit 1
      ;;
  esac
  shift 2
fi

cli_list=
if [ "${1-}" = --prisma-cli ]; then
  cli_list=$2
  if [ ! -f "$cli_list" ]; then
    echo "prune-node-modules: the list $cli_list does not exist" >&2
    exit 1
  fi
  shift 2
fi

# Deletes from the tree $1 every `delete` path of $cli_list, then checks that every `keep` path of it is there.
prune_prisma_cli() {
  for pass in delete keep; do
    # The test `|| [ -n "$keyword" ]` also reads a last line that lacks its newline.
    while read -r keyword entry rest || [ -n "$keyword" ]; do
      case $keyword in
        '' | '#'*) continue ;;
        version | delete | keep) ;;
        *)
          echo "prune-node-modules: $cli_list has the unknown keyword $keyword" >&2
          exit 1
          ;;
      esac
      if [ -z "$entry" ] || [ -n "$rest" ]; then
        echo "prune-node-modules: $cli_list has a $keyword line without exactly one value" >&2
        exit 1
      fi
      [ "$keyword" = "$pass" ] || continue
      found=
      # The unquoted entry expands its `*` as in sh, and a pattern that matches nothing stays as it is.
      for path in "$1"/$entry; do
        if [ -e "$path" ]; then
          found=1
          if [ "$pass" = delete ]; then rm -r -- "$path"; fi
        fi
      done
      if [ -z "$found" ] && [ "$pass" = delete ]; then
        echo "prune-node-modules: $1 holds no $entry, which $cli_list deletes" >&2
        exit 1
      fi
      if [ -z "$found" ]; then
        echo "prune-node-modules: $1 lacks $entry, which the image's commands load and $cli_list keeps" >&2
        exit 1
      fi
    done < "$cli_list"
  done
}

for tree in "$@"; do
  find "$tree" -type d \( -name __tests__ -o -name test -o -name tests -o -name doc -o -name docs -o -name example \
    -o -name examples \) -prune \
    -exec sh -c 'for dir; do if [ -f "$dir/../package.json" ]; then rm -r "$dir"; fi; done' sh {} +
  find "$tree" -type d -name test-utils -prune \
    -exec sh -c 'for dir; do if [ ! -f "$dir/package.json" ]; then rm -r "$dir"; fi; done' sh {} +
  find "$tree" -type f \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \
    -o -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.ts.map' -o -name '*.mts.map' \
    -o -name '*.cts.map' -o -name '*.css.map' -o -name '*.test.*' -o -name '*.spec.*' \
    -o \( \( -iname '*.md' -o -iname '*.markdown' \) ! -iname 'licen[cs]e*' ! -iname 'notice*' \) \) -delete
  if [ -n "$provider" ]; then
    compilers=$(find "$tree" -type f -name 'query_compiler_*_bg.*' \
      | grep -E '/query_compiler_[a-z]+_bg\.[a-z0-9]+\.(js|mjs|wasm|wasm-base64\.m?js)$' || true)
    if [ -n "$compilers" ]; then
      if ! printf '%s\n' "$compilers" | grep -q "_bg\.$provider\."; then
        echo "prune-node-modules: $tree has Prisma query compilers, but none for provider $provider" >&2
        exit 1
      fi
      printf '%s\n' "$compilers" | grep -v "_bg\.$provider\." | while IFS= read -r file; do rm -- "$file"; done
    fi
  fi
  find "$tree" -type d \( -path "*/@img/sharp-$other_libc-*" -o -path "*/@img/sharp-libvips-$other_libc-*" \) -prune \
    -exec rm -r {} +
  if [ -f "$tree/sharp/package.json" ] \
    && ! ls -d "$tree/@img/sharp-$libc-"* "$tree/@img/sharp-libvips-$libc-"* > /dev/null 2>&1; then
    echo "prune-node-modules: $tree has sharp, but no sharp build for $libc" >&2
    exit 1
  fi
  if [ -n "$cli_list" ]; then prune_prisma_cli "$tree"; fi
done
