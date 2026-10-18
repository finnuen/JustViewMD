# Changelog

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
