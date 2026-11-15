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
    COMPREPLY=($(compgen -W "-v --verbose --no-fetch -j --jobs -h --help" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$(cc-status --list-mods 2>/dev/null)" -- "$cur"))
  fi
}

complete -F _cc_status cc-status
