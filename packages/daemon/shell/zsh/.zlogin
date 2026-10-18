ZDOTDIR=$MIKS_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zlogin ]] && builtin source "$ZDOTDIR/.zlogin"
MIKS_USER_ZDOTDIR=$ZDOTDIR
__miks_restore_zdotdir
