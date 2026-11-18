# Changelog

## 1.18

* A bare web address in a link works without the document having been saved:
  `[text](google.com)` and `[text](www.google.com/search?q=1)` open as
  `https://...`. Before, they were taken for a file next to the document, which
  an unsaved document cannot have, so the link only said to save first. A name
  that ends in an extension this program knows - `README.md`, `image.png` - is
  still a file.

## 1.17

* A screenshot at the top of the README shows a selection mirrored between the
  two panes.

## 1.16

* A picture a document names with a Windows path now appears: `![alt](E:\Pictures\shot.png)`
  was left as a broken image, because the renderer percent-encodes a Markdown
  destination and `E:\` arrived as `E:%5C`, which read as an unknown URL scheme.
  The address is decoded before it is recognised, so backslashes, forward
  slashes and `file:///` all work, in a Markdown image and in an `<img>` tag.
* A link in the preview no longer opens inside the window. An address with a
  scheme goes to the default browser, a link to another document opens it in a
  tab, and a link to any other file opens that file in its own program; a link
  to a file that is not there says so. Before, an absolute address loaded the
  page in place of the program, and a relative one - a placeholder like `url` -
  navigated to a missing page under the program's own address.
* The image button inserts a centred picture with a width, since Markdown has no
  syntax for either: a selected address becomes the source, a selected
  `![alt](path)` is turned into that block, and the address is left selected.
* A callout button, for the note, tip, important, warning and caution boxes the
  renderer draws.

## 1.15

* A click lets the selection go. Anything that drops the selection in the
  rendered page - a click in the preview, on its scrollbar, or anywhere else
  that leaves nothing picked - clears the highlight and the range it had put in
  the source, and clicking in the editor clears the highlight in the preview.
  Before, the highlight stayed on the page until another selection replaced it.

## 1.14

* A selection in the preview is selected in the source, the other half of what
  1.13 started: words picked in the rendered page are found in the editor and
  the editor takes the focus, so a phrase can be changed without hunting for it
  by eye. A drag that starts or stops inside a word is matched from that place.
* The two panes now agree word for word on what a document says. The rendered
  page and the source file were counted as word sequences, and every place they
  drifted apart is fixed: a tag written inside a code span or a fenced block is
  text and not markup, an HTML comment is not a word, `p < 0.001` is three
  words and not the start of a tag, `\|` in a table cell is one character, a
  word split by a syntax-highlighting span is one word, and `<b>Fast</b>er`
  reads as "Faster". Without that, a selection could land one word off.
* A word is selected together with the inline markup that wraps it, so the
  selection in the editor is something that can be typed over and back in:
  "settings.ini" on the page selects `settings.ini` in the file, and
  "Ctrl+wheel" selects `Ctrl`+wheel.

## 1.13

* A selection made in the editor is painted in the preview where the same
  words sit, in both themes. The rendered text is not the source text, so the
  two are matched by their words: a selection that starts or ends inside a
  word is marked from that place, and a phrase that occurs more than once is
  marked at the line it was selected on. Selecting in the preview is
  unaffected, and a selection too long to be a locator is left alone.

## 1.12

* Callouts: a blockquote that opens with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
  `[!WARNING]` or `[!CAUTION]` is drawn as a titled box with its own icon and
  colour, in both themes. A title written after the marker replaces the default
  one.
* A `<picture>` that offers a dark and a light file now follows the theme the
  window is using. The old code left the choice to the embedded browser, which
  went by the system scheme, and it never resolved the file named in `srcset`,
  so pictures such as a README's screenshots were left broken in dark mode.
  A `srcset` on a plain `<img>` is resolved too.
* Every fenced code block has a copy button in its corner, shown while the
  pointer is over the block; it turns into a tick after the copy.
* The preview is laid out as a README normally is: 16px text on a 1.5 line
  height in a 1012px column, the heading scale and margins that go with it,
  full-width tables, quieter block quotes, a solid rule, and code blocks
  without a border. Both themes follow the same rules.
* A single newline joins its paragraph instead of breaking it, which is what
  the Markdown dialect says; a line that really ends carries two trailing
  spaces or a `<br>`.

## 1.11

* The menu bar opens on hover. Resting the pointer on **File**, **Edit** or
  **Options** brings its menu down without a click, and sliding along the bar
  replaces it; moving away from the bar and the menu closes it. A click still
  opens one at once.
* Buttons act when the mouse button is released, not when it is pressed. The
  tab close button was the one that did not: pressing it closed the tab at
  once, so a press the user dragged off - or took back - still closed it. It
  now closes on release, over the button it was pressed on, and pressing it
  no longer selects the tab behind it. A middle click on a tab closes it on
  release too, and only over the tab it started on. The bars on the find
  scrollbar and the About dialog's backdrop follow the same rule.

## 1.10

* Open documents are always remembered. *Keep opened files* is gone from the
  Options menu: a start reopens the documents of the previous run in the same
  order, with the same tab active, unsaved buffers included, and a file named
  on the command line joins them.
* Unsaved buffers survive a crash, and closing the window no longer asks
  whether to save anything. While a tab has changes that are not in its
  document, its text is written to `%LOCALAPPDATA%\JustViewMD\unsaved\`, a
  couple of seconds behind the typing and on a tab switch, a blur or a hide;
  closing the window writes the newest text one last time. The next start
  opens those buffers as tabs again, still marked unsaved, whatever the file
  type. Saving the tab, reloading it, or closing the tab itself with **No**
  removes its copy, through the Recycle Bin like every other file the
  application deletes.
* A footnote reference and its return arrow now scroll the preview pane instead
  of the page body. Following one used to scroll the body, which left the window
  with the document shrunk into the top of the frame, a stray status bar at the
  bottom and no way back, and it left `#fn-1` in the address. Fragment links are
  handled in the page now, and the body cannot scroll at all.

## 1.9

* **About JustViewMD** at the end of the Options menu: which build is running,
  the licence, and the full text of the Apache License 2.0. The text is compiled
  into the executable and read from there, so a single `.exe` carries its own
  licence the way section 4(a) of that licence asks, with nothing to install
  beside it. `Esc`, the close button and a click on the backdrop all close it.
* The licence is Apache 2.0 from this release on; it was MIT. Earlier releases
  stay MIT, because that grant cannot be taken back.

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
