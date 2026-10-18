ZDOTDIR=$MIKS_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && builtin source "$ZDOTDIR/.zshrc"
MIKS_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__miks_zdotdir

# Miks's pbcopy (../bin) ahead of Apple's. Here, after your startup files,
# because macOS's path_helper puts /usr/bin back in front of anything before.
path=("${__miks_zdotdir:h}/bin" $path)

# This tab's own history (MIKS_HISTORY, kept by the daemon across restarts):
# each command it runs, written as it runs in zsh's history format, then read
# back last when the tab returns, so ↑ starts with what this tab was doing.
# Your shared history goes on as ever, before it.
if [[ -n $MIKS_HISTORY ]]; then
  if [[ -s $MIKS_HISTORY ]]; then
    __miks_lines=("${(@f)$(<$MIKS_HISTORY)}")
    # Only the last few hundred lines, cut where a command starts (after a
    # line that doesn't continue onto the next with a backslash).
    if (( $#__miks_lines > 400 )); then
      __miks_start=$(( $#__miks_lines - 199 ))
      while (( __miks_start > 1 )) && [[ ${__miks_lines[__miks_start - 1]} == *\\ ]]; do
        (( __miks_start-- ))
      done
      builtin print -rl -- "${(@)__miks_lines[__miks_start,-1]}" >| $MIKS_HISTORY
    fi
    builtin fc -R $MIKS_HISTORY
    unset __miks_lines __miks_start
  fi
  __miks_remember() {
    # zsh's history format: a newline within a command follows a backslash.
    local nl=$'\n'
    builtin print -r -- "${${1%$nl}//$nl/\\$nl}" >> $MIKS_HISTORY
  }
fi

# Marks around each command (OSC 133, as Ghostty, iTerm and VS Code read
# them): A where a prompt starts, C where a command's output starts, D where
# it ends. "Select last command" (⌘⇧A) goes by them.
__miks_precmd() {
  local ret=$?
  if [[ -n $__miks_running ]]; then
    builtin print -n "\e]133;D;$ret\a"
    unset __miks_running
  fi
  builtin print -n "\e]133;A\a"
}
__miks_preexec() {
  __miks_running=1
  builtin print -n "\e]133;C\a"
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __miks_precmd
add-zsh-hook preexec __miks_preexec
[[ -n $MIKS_HISTORY ]] && add-zsh-hook preexec __miks_remember

# ⌥←/→ by word. With Option as Meta, Miks sends them as xterm does
# (ESC [1;3D), which zsh leaves unbound; Terminal.app's ESC b/f already are.
# Yours win: only keys you haven't bound.
for __miks_key __miks_widget in '^[[1;3D' backward-word '^[[1;3C' forward-word; do
  [[ $(bindkey -- $__miks_key) == *undefined-key ]] && bindkey -- $__miks_key $__miks_widget
done
unset __miks_key __miks_widget

# Without -l there's no .zlogin to come.
[[ -o login ]] || __miks_restore_zdotdir
