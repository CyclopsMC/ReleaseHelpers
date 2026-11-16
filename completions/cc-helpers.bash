# Bash completion for the ReleaseHelpers commands.
# Usage: add `source /path/to/ReleaseHelpers/completions/cc-helpers.bash` to ~/.bashrc.

_cc_status() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local prev="${COMP_WORDS[COMP_CWORD-1]}"
  COMPREPLY=()
  if [[ "$prev" == "-j" || "$prev" == "--jobs" ]]; then
    return
  fi
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "-v --verbose --no-fetch --fetch-all --no-dashboard -j --jobs -h --help" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$(cc-status --list-mods 2>/dev/null)" -- "$cur"))
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
    COMPREPLY=($(compgen -W "$(cc-status --list-mods 2>/dev/null)" -- "$cur"))
  elif [[ $positional -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$(cc-status --list-versions 2>/dev/null)" -- "$cur"))
  fi
}

_cc_build() {
  COMPREPLY=($(compgen -W "--env -h --help" -- "${COMP_WORDS[COMP_CWORD]}"))
}

complete -F _cc_status cc-status
complete -F _cc_release_chain cc-release-chain
complete -F _cc_build cc-build

_cc_mark() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "no-release release clear list" -- "$cur"))
  elif [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "--reason" -- "$cur"))
  fi
}

complete -F _cc_mark cc-mark

_cc_dashboard() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  if [[ "${COMP_WORDS[COMP_CWORD-1]}" == "--port" ]]; then
    COMPREPLY=()
  elif [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "--port --open -h --help" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "open install uninstall" -- "$cur"))
  fi
}

complete -F _cc_dashboard cc-dashboard
