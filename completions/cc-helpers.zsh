# Zsh completion for the ReleaseHelpers commands.
# Usage: add `source /path/to/ReleaseHelpers/completions/cc-helpers.zsh` to ~/.zshrc.

if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit
fi

_cc_helpers_mods() {
  local -a mods
  mods=(${(f)"$(cc-status --list-mods 2>/dev/null)"})
  _describe -t mods 'mod' mods
}

_cc_status() {
  _arguments -s \
    '(-v --verbose)'{-v,--verbose}'[list the commits behind each cell]' \
    '--no-fetch[use the current remote-tracking branches]' \
    '--fetch-all[fetch every checkout, without asking GitHub what changed]' \
    '(-j --jobs)'{-j,--jobs}'[number of repos to process in parallel]:jobs:' \
    '(- *)'{-h,--help}'[show help]' \
    '*:mod:_cc_helpers_mods'
}

_cc_mark() {
  if (( CURRENT == 2 )); then
    local -a actions
    actions=(
      'no-release:the commits need no release'
      'release:the commits need a release'
      'clear:remove the marks'
      'list:show all marks'
    )
    _describe -t actions 'action' actions
  else
    _arguments '--reason[why]:reason:' '*:commit:'
  fi
}

compdef _cc_status cc-status
compdef _cc_mark cc-mark
