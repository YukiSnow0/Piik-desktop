# Upstream and attribution

This project is a community desktop wrapper developed with GPT / Codex assistance.
It builds on Piik by TNTcraftHIM and Piik contributors:

- Source: https://github.com/TNTcraftHIM/Piik
- Official mirror: https://gitee.com/TNTcraftHIM/Piik
- Upstream license: MIT, retained in the repository's LICENSE file.

The Go room service, native capture and public-link helpers are distributed by
the upstream Piik App release. The desktop build downloads a complete official
Windows x64 package and verifies it against desktop/runtime.json. Application
updates read official release metadata and verify publisher checksums before
trying a candidate runtime. They do not rebuild upstream main.

The initial bundled runtime is Piik 2.5.0, upstream source revision
499789671c7530b7364818b9c07123f3f290ebad. Pinned URLs and the archive checksum live
in desktop/runtime.json, which is the build's source of truth.

Three build resources are retained from upstream revision
e169b48aaaf5ff55f52a7bcb15db115849c2efbd:

- public/favicon.svg
- cmd/piik-app/piik.ico
- src/client/ui/palette.css

These paths let the preparation script reuse Piik's brand resources and palette.
They are not a copy of the full upstream frontend or server source. The official
runtime includes LICENSE and THIRD-PARTY-NOTICES.txt, and Electron/Chromium
notices remain in desktop builds.
