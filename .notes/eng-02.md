# ENG-02: one registry for the built-in faces

## CLAUDE.md: replacement for "A new built-in face goes into ..."

A new built-in face is one entry in `renderer/js/faces/registry.mjs` (`BUILT_IN_FACES`: id, title, tagline, `module` relative to `renderer/js`, `export` = the class), plus its own name in the phone's `renderer/remote/sw.js` `FACES` (a classic worker can't import the registry; bump `CACHE`). Everything else derives from it: the desktop gallery (`faces/host.js` `BUILT_IN`, its classes loaded by a top-level `await import()`), the phone (`renderer/remote/app.js` `FACE_MODULES`), the watch's recording page (`renderer/js/facecapture.js`), the companion server's `STATIC` face files and `FACES` and the tools' `FACES` (`main/tools/common.js`), both through `main/facesregistry.js` (the chartcore pattern), and `test/facedraw.test.js`. `FACE_FILES` (the face modules, `themecore.js`, `faces/env.js`, `faces/common.js` and the registry itself) is what devices are served and cache; `test/facesregistry.test.js` checks every entry's module exports its class, that sw.js caches exactly `FACE_FILES`, and that no file keeps its own copy of the list.

## CHANGELOG line

- The built-in faces are listed once (`renderer/js/faces/registry.mjs`): the desktop gallery, the phone, the watch's face recording, the companion server and the tools all read that list, so a new face is one entry instead of edits in seven files.
