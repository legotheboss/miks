ZDOTDIR=$MIKS_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zprofile ]] && builtin source "$ZDOTDIR/.zprofile"
MIKS_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__miks_zdotdir
