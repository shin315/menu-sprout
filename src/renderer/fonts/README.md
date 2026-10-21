# Bundled fonts

Third-party font assets and their notices. For renderer loading and packaging details in the source checkout, see [Build wiring](../../../docs/development.md#build-wiring).

| Family | Directory | Upstream | Copyright and license notice |
| --- | --- | --- | --- |
| JetBrains Mono | `jetbrains-mono/` | https://github.com/JetBrains/JetBrainsMono | [OFL.txt](jetbrains-mono/OFL.txt) |
| Inter Tight | `inter-tight/` | https://github.com/rsms/inter-tight | [OFL.txt](inter-tight/OFL.txt) |

The files are the unmodified variable woff2 subsets (cyrillic, cyrillic-ext, greek, greek-ext where available, latin, latin-ext, vietnamese) downloaded from Google Fonts for `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Inter+Tight:wght@300;400;500;600&display=swap` (JetBrains Mono v24, Inter Tight v9).
`fonts.css` keeps that response's `@font-face` blocks, weights, and `unicode-range`s, with the URLs pointed at the local files.
To refresh them, fetch that URL with a current Chrome user agent, download each referenced woff2 under the existing family/subset file names, and update `fonts.css` with the returned font-face descriptors and local URLs.
