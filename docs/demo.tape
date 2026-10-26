# Records docs/demo.gif. From the repo root:
#   (cd examples/demo && npm i --no-save --no-package-lock graphql-overfetch)
#   vhs docs/demo.tape

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1240
Set Height 600
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "cd examples/demo && export PS1='$ ' && clear"
Enter
Show

Type "npx graphql-overfetch"
Sleep 400ms
Enter
Sleep 4.5s

Hide
Type "clear"
Enter
Show

Type "npx graphql-overfetch overfetch"
Sleep 400ms
Enter
Sleep 5.5s
