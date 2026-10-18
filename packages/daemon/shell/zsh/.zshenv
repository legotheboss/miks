# Miks's zsh integration (see Pane.ts). zsh reads its startup files from
# $ZDOTDIR, which Miks points here; each of these reads yours, at the top
# level as zsh would, and the last one to run puts ZDOTDIR back. Yours are in
# $MIKS_USER_ZDOTDIR, kept current in case your .zshenv moves them.

__miks_zdotdir=$ZDOTDIR
ZDOTDIR=${MIKS_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && builtin source "$ZDOTDIR/.zshenv"
MIKS_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__miks_zdotdir

__miks_restore_zdotdir() {
  if [[ $MIKS_USER_ZDOTDIR == $HOME ]]; then
    unset ZDOTDIR
  else
    export ZDOTDIR=$MIKS_USER_ZDOTDIR
  fi
  unset MIKS_USER_ZDOTDIR __miks_zdotdir
  unfunction __miks_restore_zdotdir
}

# A script's zsh reads nothing more.
[[ -o interactive ]] || __miks_restore_zdotdir
