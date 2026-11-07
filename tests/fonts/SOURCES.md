# RTL font test fixtures

These local fixtures support offline shaping and font fallback tests. Each is the pinned public Fontsource TTF subset for weight 400, normal style, from package version `5.3.0`. The corresponding OFL text is copied from the same pinned package. The catalog API's `version` values are recorded as provenance; they are distinct from the npm package version used in the URLs.

| Family | Subset | Catalog version | Package version | TTF bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| Noto Sans Arabic | `arabic` | `v33` | `5.3.0` | 151,388 | `40b54820d53b3c2e40e437cc47afe084a8a8997a90656a593f16982a030dace2` |
| Noto Sans Hebrew | `hebrew` | `v50` | `5.3.0` | 17,220 | `47202b2373dbd7f2aa17958ff4585ade5020eda652016fcb9425356534894e10` |

Public metadata and source URLs:

- Arabic metadata: <https://api.fontsource.org/v1/fonts/noto-sans-arabic>. The API reports family `Noto Sans Arabic`, npm version `5.3.0`, catalog version `v33`, default subset `latin`, subset `arabic`, and license `OFL-1.1`.
- Arabic TTF: <https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-arabic@5.3.0/arabic-400-normal.ttf>
- Arabic package license: <https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-arabic@5.3.0/LICENSE>. Local copy: `noto-sans-arabic-LICENSE.txt`; SHA-256 `91053c23e8a0fe5fc9b5fdbe5ff74ceffd66f6f996c123f1a6ca4c23487c1fff`.
- Hebrew metadata: <https://api.fontsource.org/v1/fonts/noto-sans-hebrew>. The API reports family `Noto Sans Hebrew`, npm version `5.3.0`, catalog version `v50`, default subset `latin`, subset `hebrew`, and license `OFL-1.1`.
- Hebrew TTF: <https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-hebrew@5.3.0/hebrew-400-normal.ttf>
- Hebrew package license: <https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-hebrew@5.3.0/LICENSE>. Local copy: `noto-sans-hebrew-LICENSE.txt`; SHA-256 `7387750a626d005e86adc8b9321567f001fc2f6ef5c8f275261c454fe86981d4`.

`rtl-fonts.mjs` uses the API's `arabic` and `hebrew` Unicode ranges with canonical local catalog face URLs. It reads these checked-in files and the app's bundled fonts only; tests do not access the network.

## Variable font fixture

`roboto-flex-axes-subset.ttf` (27,608 bytes, SHA-256 `4f561e658e099451216045624127cc2a21d3b9ecfa7e80d257f2913a4d7dc07e`) is Roboto Flex (OFL-1.1, no Reserved Font Name) from <https://github.com/google/fonts/tree/main/ofl/robotoflex> (source TTF SHA-256 `9b523f7d82593df0107173849ebb8c817471a1df4b4fb2c3cbf40cfd810c8281`), cut down with fontTools 4.59: `varLib.instancer` dropped every axis but wght, wdth, slnt and opsz, and `subset --text="kinoKINOAa" --layout-features=kern --no-hinting` kept those letters. License copy: `roboto-flex-LICENSE.txt`. The variable font tests (`engine/fontAxes.test.js`, `backend/agent-reach-features.test.mjs`) use it.
