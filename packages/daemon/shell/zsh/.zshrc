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

# ⌥←/→ by word. With Option as Meta, Miks sends them as xterm does
# (ESC [1;3D), which zsh leaves unbound; Terminal.app's ESC b/f already are.
# Yours win: only keys you haven't bound.
for __miks_key __miks_widget in '^[[1;3D' backward-word '^[[1;3C' forward-word; do
  [[ $(bindkey -- $__miks_key) == *undefined-key ]] && bindkey -- $__miks_key $__miks_widget
done
unset __miks_key __miks_widget

# Without -l there's no .zlogin to come.
[[ -o login ]] || __miks_restore_zdotdir
