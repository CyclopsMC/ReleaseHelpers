# Bash completion for the ReleaseHelpers commands.
# Usage: add `source /path/to/ReleaseHelpers/completions/cc-helpers.bash` to ~/.bashrc.

_cc_mark() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "no-release release clear list" -- "$cur"))
  elif [[ "${COMP_WORDS[COMP_CWORD-1]}" == "--version" ]]; then
    COMPREPLY=($(compgen -W "$(cc-mark --list-versions 2>/dev/null)" -- "$cur"))
  elif [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "--version --all-versions --reason" -- "$cur"))
  fi
}

_cc_release_chain() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local i positional=0
  COMPREPLY=()
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "--rehearse --confirm --no-review --no-build -h --help" -- "$cur"))
    return
  fi
  for ((i = 1; i < COMP_CWORD; i++)); do
    [[ "${COMP_WORDS[i]}" != -* ]] && positional=$((positional + 1))
  done
  if [[ $positional -eq 0 ]]; then
    COMPREPLY=($(compgen -W "$(cc-release-chain --list-mods 2>/dev/null)" -- "$cur"))
  elif [[ $positional -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$(cc-release-chain --list-versions 2>/dev/null)" -- "$cur"))
  fi
}

_cc_build() {
  COMPREPLY=($(compgen -W "--env -h --help" -- "${COMP_WORDS[COMP_CWORD]}"))
}

complete -F _cc_mark cc-mark
complete -F _cc_release_chain cc-release-chain
complete -F _cc_build cc-build
