# Dashboard fonts

JetBrains Mono 2.304, Regular and Bold, the original web fonts from
[JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/webfonts).
SIL Open Font License 1.1, in [JetBrainsMono-OFL.txt](JetBrainsMono-OFL.txt).
Copyright 2020 The JetBrains Mono Project Authors.

The full fonts are used (not a Latin subset) because the dashboard draws its panes with
box-drawing characters. JetBrains Mono has no braille, so spinners and sparklines fall back
to the system's braille font inside fixed one-character cells.

Bricolage Grotesque (variable weight, Latin) is the dashboard's text face and DM Mono (Regular
and Medium, Latin) its face for times, numbers and commands; JetBrains Mono stays as the
fallback for box-drawing characters and is the viewer's face. Both are under the SIL Open Font
License 1.1: [BricolageGrotesque-OFL.txt](BricolageGrotesque-OFL.txt), Copyright 2022 The
Bricolage Grotesque Project Authors, and [DMMono-OFL.txt](DMMono-OFL.txt), Copyright 2020 The DM
Mono Project Authors. The files are the Latin web fonts from the Fontsource packages
`@fontsource-variable/bricolage-grotesque` and `@fontsource/dm-mono`.
