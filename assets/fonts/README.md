# Bundled fonts

Inter's normal faces were converted from the matching Fontsource WOFF files to
TrueType without changing their outlines. Inter's italic faces, Montserrat's
faces, and Noto Serif's normal/italic faces are the original Fontsource WOFF2
files. Fontkit reads those
bytes in both the browser and export service; exports contain the shaped glyph
outlines and do not require installed fonts.

- Inter: [Fontsource](https://fontsource.org/fonts/inter), SIL Open Font License
  in [OFL.txt](OFL.txt).
- Montserrat: [Fontsource](https://fontsource.org/fonts/montserrat), SIL Open Font
  License in [Montserrat-OFL.txt](Montserrat-OFL.txt).
- Noto Serif: [Fontsource](https://fontsource.org/fonts/noto-serif), SIL Open Font
  License in [NotoSerif-OFL.txt](NotoSerif-OFL.txt).

Bundled faces cover the Latin subsets distributed with these files. Other
families and character coverage can be imported as TTF, OTF, WOFF, or WOFF2.
Unloaded fonts and missing glyphs produce an explicit error.
