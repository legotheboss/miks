ZDOTDIR=$MIKS_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && builtin source "$ZDOTDIR/.zshrc"
MIKS_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__miks_zdotdir

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

# Without -l there's no .zlogin to come.
[[ -o login ]] || __miks_restore_zdotdir
