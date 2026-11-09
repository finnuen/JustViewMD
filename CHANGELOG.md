# Changelog

## 1.8

* A formatting bar along the bottom of the editor. Bold, italic, strikethrough,
  inline code, superscript and subscript; H1-H3; block quote, bulleted, numbered
  and task lists; fenced code block, table, horizontal rule and footnote; link
  and image; inline math, display math and a Mermaid diagram. A button acts on
  the selection, or on the lines the caret is on when nothing is selected; a
  second press takes its own markers away, and one `Ctrl+Z` takes the whole
  change back. `Ctrl+B`, `Ctrl+I` and `Ctrl+K` do the same from the editor, and
  every button carries a tooltip.
* A picture a document points at next to itself renders now: `assets/demo.png`,
  `../shared/x.png`, an absolute `C:\...` path, a `file:///` address and a path
  with `%20` all resolve against the folder of the document being previewed.
  The host reads the file and serves it to the page from an origin of its own,
  so nothing is copied into the picture cache and no request leaves the machine.
  A missing or unreadable file keeps the broken-image placeholder and says why.

## 1.7

* A scroll to top / scroll to bottom pair in the bottom right corner, the way a
  long web page has one. Both buttons appear while the reader is scrolling and
  fade out a second after the last move; the one for the end already reached is
  dimmed. They move the pane that owns the reading position, so a jump keeps the
  other pane, the remembered place and the find marks in step like any other
  scroll.

## 1.6

* The reading position survives the things that used to lose it: *Reload from
  Disk*, zoom in / out / reset (menu, keyboard and Ctrl+wheel), switching between
  split, editor and preview, turning line wrapping on or off, dragging the
  divider, and resizing the window. It is remembered as the source line at the
  top of the pane rather than as a pixel offset, so the same place means the same
  thing after the layout has changed.
* The version is two numbers now - `1.6` - instead of three. The tag
  (`1.6`), the release title (`JustViewMD v1.6`) and the title bar follow it, and
  a build bumps the last number.

## 1.0.5

* Find marks every match on the preview's scrollbar, the way a browser does: a
  short bar for each match at the height it has in the document, with the
  current one taller and brighter. Clicking a bar goes to that match and leaves
  the focus in the find box, so typing can carry on; the marks go away when the
  find bar closes. A document with more matches than the bar can keep apart
  shows an evenly sampled subset instead of one solid line.
* The window title names the version (`JustViewMD v1.0.5`). A release is
  downloaded as `JustViewMD.exe` with no version in the file name, so an update
  replaces the old copy in place and keeps its "Open with" entry and default-app
  choice; the title bar is where the version is read instead.

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
