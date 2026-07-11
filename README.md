# Git Change Highlighter

Cursor-style line highlighting for git changes. Highlights every changed line in the active file with a full-line background — the same visual feel as Cursor's AI-edit review — and lets you step through, accept, or reject each change one at a time.

## Features

- Highlights only the actual changed (`+`) lines relative to `HEAD`, not the whole surrounding block.
- Inline "Accept" / "Reject" links above each change (via CodeLens), plus a `Change X/N` counter.
- `Reject` reverts just that hunk in place using `git apply -R`, the same mechanism VS Code's own "Revert Selected Ranges" uses.
- `Accept` dismisses the highlight for that change without touching git (no staging).
- Status bar navigator (bottom-left) — `Prev` / `X/N changes` / `Next` — to step through changes across the file.
- Commands `Git Change Highlighter: Next Change` / `Previous Change`, bound to `Ctrl+Alt+N` / `Ctrl+Alt+P`.
- Activates automatically on startup and refreshes on save or git state changes (e.g. after a coding agent edits and you save).

## Requirements

Relies on the built-in VS Code `vscode.git` extension (bundled with VS Code) — no additional setup needed.

## Known Issues

- Only reflects **saved** changes, since it diffs against the file on disk (same as `git diff`). Unsaved buffer edits won't highlight until saved.
- `Reject` requires the file to be saved first.
- Pure deletions (lines removed with nothing added) show a CodeLens marker at the surrounding line but have nothing to highlight.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
# Cusor-Style-Line-Highlighter
