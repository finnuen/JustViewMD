# Changelog

## 1.0.4

* The dark theme has a new palette.  The window, the tabs, the editor and the
  rendered preview use a near-black canvas (`#0d1117`) and slightly lighter
  surfaces (`#151b23`), borders at `#3d444d`, text at `#f0f6fc`, muted text at
  `#9198a1` and a blue accent at `#4493f8` instead of the previous blue-grey
  palette.  The title bar and the WebView's first paint carry the same canvas
  colour, so nothing flashes a different shade while a document opens.
* Fenced code blocks are highlighted to match (comments muted, keywords red,
  strings pale blue, numbers blue, functions violet, tags green), and Mermaid
  diagrams use the same palette as the rest of the preview.
* Printing and *Save as PDF…* from the dark theme keep the light syntax colours
  as well as the light page palette, so a dark window still prints a legible
  document.
* Switching the theme no longer scrolls the preview back to the top; the reader
  stays where they were.
* The light theme is untouched.

## 1.0.3

* Markdown files keep the document icon, and the executable keeps its own.
  Explorer takes a document's icon from whichever registration it resolved the
  handler through, and the "Open with" entry it creates is keyed by the
  executable's name - which carries the version - so a renamed executable left
  `.md` files wearing the application's badge. Both registrations are written on
  every start now, and the entries earlier versions left behind are repaired in
  place, so neither a rename nor an upgrade can mix the two icons up.
* `.mdx` gets the "Open with JustViewMD" context-menu entry as well; it was
  already offered as a default application, but the menu entry only covered
  `.md` and `.markdown`.

## 1.0.2

* Print and PDF. *File → Print…* (`Ctrl+P`) prints the rendered document through
  the system print dialog, and *File → Save as PDF…* writes the same pages to a
  file you choose. The print stylesheet drops the editor, the tabs and the
  status bars, prints the light palette even from the dark theme, keeps headings
  with the text that follows them, and keeps wide tables and pictures on one
  page.
* Find no longer switches preview-only back to split when it opens, and it now
  works in the preview as well: matches are highlighted where they are rendered,
  the current one is singled out and scrolled to, and `Enter` / `Shift+Enter`
  keep advancing from the match that is highlighted.
* The dark theme paints find hits yellow, like the light theme, instead of a
  blue that read like a selection.
* The executable carries its version in its name (`JustViewMD_v1.0.2.exe`) and
  every build bumps the patch number on its own. `build.bat --keep-version`
  rebuilds the current number unchanged and `--version X.Y.Z` sets it outright.
* The tab strip is 25 px tall instead of 28 px.
* PDF export from the dark theme no longer puts a dark border around every
  page. Chromium paints the sheet with the window's background colour when
  backgrounds are printed; the export now borrows white paper while it writes.

## 1.0.1

* "Keep opened files" now keeps them when the next start is asked for a file:
  `open a.md`, close, `open b.md` shows `a.md` and `b.md`, with `b.md` active,
  instead of replacing the session with `b.md`. A file that is already open is
  activated rather than opened twice.
* Tabs can be dragged sideways to reorder the strip. The order follows into the
  saved session, and the active tab stays active as it moves.
* The tab strip is 28 px tall instead of 33 px, so the editor starts that much
  higher up the window.

## 1.0.0

The version that has a version.  Everything the application shows now comes from
one number in `CMakeLists.txt` - the file properties, the Options menu and the
update check - and this is the first release published as a single executable
with nothing beside it.

* Tabs, with `+` for a new tab, a close button on each, dirty markers, a
  numbered `Untitled.md` series, and `Ctrl+Tab` cycling.
* Split view with a resizable divider, a line-number gutter, a status bar with
  counts, and scroll synchronisation driven by the source line each rendered
  block came from.
* Editing: find and replace with case, whole-word and regular-expression
  switches; zoom with the keyboard or `Ctrl`+wheel; light and dark themes; a
  context menu of its own rather than the browser's.
* Rendering: GitHub Flavored Markdown, KaTeX math, Mermaid diagrams and Prism
  syntax highlighting, all vendored inside the executable.
* Pictures a document links to are fetched once by the host, cached under
  `%LOCALAPPDATA%\JustViewMD\cache` and served to the page from
  `https://cache.local`, so a document that has been opened once renders offline
  from then on.  The cache is never pruned by the application.
* Options and the session live in `settings.ini`, written atomically; values
  left in `HKCU\Software\JustViewMD` by earlier releases are migrated on first
  start and then removed.
* Windows integration: Explorer context menu, optional `.md` associations,
  document icon, drag and drop anywhere in the window, per-monitor DPI
  awareness.
* The version is visible in *Options → Check for update...*, which asks GitHub
  for the newest release - quietly in the background on start-up, and with a
  toast when the menu asks.
