# ENG-07: every silent catch says why

## CLAUDE.md (Logging section, a new bullet)
- A dropped error says why. `p.catch(ignore('reason'))` (`main/ignore.js`; in the window `ignore` from `renderer/js/util.js`) writes a DEBUG line `ignored` `{ reason, error }` (only with Detailed logging on) and yields its second argument as the fallback (`ignore('no vault', null)`); a short trailing comment does as well where the reason is plain (a queue that only orders work, a missing file read as none, a worker or pure module that can't import the logger). A failure the user or the log should know about (a data write, a self-change step, a security decision) is a `log.warn`, never ignored. `npm run check` fails on `.catch(() => {})`, `.catch(() => null|undefined|false)` and an empty `catch {}` / `catch (e) {}` with no comment after it on the same line or inside the block (`codemap.silentCatches`, `scripts/verify.js`), in preload.js, main/ and renderer/; renderer/remote/ is only warned about for now (`SILENT_CATCH_WARN_ONLY`). `test/silentcatch.test.js`.

## CLAUDE.md (Conventions, optional one-liner)
- Never drop an error without a reason: `ignore('reason')` or a comment on that line (the check enforces it).

## docs/ENGINEERING.md §2 (replace the end of the "Fail loudly" bullet)
  tell the user something actionable; never swallow an error silently: say why it is safe with
  `ignore('reason')` (main/ignore.js, util.js) or a comment on the same line, and log at warn when
  it isn't. `npm run check` fails on a bare `.catch(() => {})` or empty `catch {}`.

## CHANGELOG.md
- For developers: every dropped error in main/ and renderer/ now says why (`ignore(reason)` in `main/ignore.js` and `renderer/js/util.js`, which logs at debug, or a comment), and `npm run check` fails on a new silent catch (renderer/remote/ is only warned about until its split lands). Seventeen swallowed failures now log a warning instead: damaged settings or routines copies not kept, settings not restored or backed up, the conversation index or remote device list not saved, a routine's status not saved, note history not saved, memories not copied from the old folder, an old Google sign-in not removed, a self-change revert not aborted, an approval answer or a Stop that didn't reach the main process.

## Follow-up
- renderer/remote/ has 11 silent catches (app.js 9, screens.js 2), warn-only; once the split lands, give them reasons and drop `SILENT_CATCH_WARN_ONLY`.
