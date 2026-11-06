#!/usr/bin/env bash
# Link the skills in skills/ into each harness's user-level skills directory.
#   ./install.sh                    link every skill
#   ./install.sh --only a b ...     link only these (plus setup, and subagents when a
#                                   chosen skill needs it) and unlink this clone's others
# ~/.agents/skills is the canonical location; Claude Code and Codex homes link to it.
# library/ is never linked globally: projects link the library skills they want.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
targets=("$HOME/.claude/skills")
for d in "$HOME"/.claude_* "$HOME"/.codex "$HOME"/.codex_*; do
  [[ -d $d/skills || -f $d/settings.json || -f $d/config.toml ]] && targets+=("$d/skills")
done

all=()
for skill in "$here"/skills/*/SKILL.md; do all+=("$(basename "$(dirname "$skill")")"); done
want=("${all[@]}")
if [[ ${1:-} == --only ]]; then
  shift
  want=(setup "$@")
  for s in "$@"; do
    [[ -f $here/skills/$s/SKILL.md ]] || { echo "no skill named $s (have: ${all[*]})" >&2; exit 2; }
    case $s in orchestrate|pacing|council) want+=(subagents) ;; esac
  done
fi
wanted() { local w; for w in "${want[@]}"; do [[ $w == "$1" ]] && return 0; done; return 1; }
# Ours: missing, or a link into this clone (any path under it, so links from an
# older layout count too). Anything else (another skill, a real folder) is kept.
ours() { [[ ! -e $1 && ! -L $1 ]] || { [[ -L $1 ]] && [[ $(readlink "$1") == "$here"/* || $(readlink "$1") == "$2" ]]; }; }

mkdir -p "$HOME/.agents/skills"
for name in "${all[@]}"; do
  link=$HOME/.agents/skills/$name
  if wanted "$name"; then
    if ! ours "$link" "$here/skills/$name"; then
      echo "kept ~/.agents/skills/$name: it isn't a link into this clone. Remove it to use this one." >&2
      continue
    fi
    ln -sfn "$here/skills/$name" "$link"
    echo "linked ~/.agents/skills/$name"
    for t in "${targets[@]}"; do
      mkdir -p "$t"
      if ours "$t/$name" "$link"; then ln -sfn "$link" "$t/$name"
      else echo "kept ${t/#$HOME/\~}/$name: it isn't a link to ~/.agents/skills/$name." >&2
      fi
    done
  elif [[ -L $link && $(readlink "$link") == "$here/skills/$name" ]]; then
    for t in "${targets[@]}"; do
      [[ -L $t/$name && $(readlink "$t/$name") == "$link" ]] && rm "$t/$name"
    done
    rm "$link"
    echo "unlinked $name"
  fi
done
echo "Linked into: ${targets[*]//$HOME/\~}"
