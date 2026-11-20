# Bash completion for the ReleaseHelpers commands.
# Usage: add `source /path/to/ReleaseHelpers/completions/cc-helpers.bash` to ~/.bash_profile on macOS,
# or ~/.bashrc elsewhere. It works with the bash 3.2 that macOS ships.

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

complete -F _cc_mark cc-mark
