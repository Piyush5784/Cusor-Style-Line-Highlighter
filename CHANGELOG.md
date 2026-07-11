# Change Log

All notable changes to the "git-change-highlighter" extension will be documented in this file.

## [0.0.5]

- Highlight only the actually-changed lines within a hunk, instead of the whole span between the first and last changed line.

## [0.0.4]

- Fixed `Reject` to write the patch to a temp file, matching the Git extension API's expected `apply(path)` signature.

## [0.0.3]

- Added per-hunk Accept/Reject via CodeLens and a bottom status-bar Prev/Next navigator.

## [0.0.2]

- Fixed automatic activation on startup instead of only on command invocation.

## [0.0.1]

- Initial release: whole-line highlighting of git changes in the active file, with next/previous navigation commands.
