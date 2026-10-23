# Working on JustViewMD

Notes for anyone (or anything) changing this repository.  The rules below are
the ones that are easy to get wrong.

## Commits and pushing

- Commit and push **straight to `main`**.  No feature branches, no pull
  requests.
- Show `git status` and the staged diff before committing: there is no review
  gate afterwards.
- **Nothing that names an AI tool.**  No `Co-Authored-By` trailer, no
  "Generated with ..." footer in a commit message, no AI tool listed in
  `CONTRIBUTING` or `AUTHORS`.  Commits carry the author's own name and email
  only.

## Releases

- A release is a tag `vX.Y.Z` with **one asset: `JustViewMD_vX.Y.Z.exe`**.  The
  executable is not committed to the repository - `dist/` is ignored and the
  release is the record of a build.
- The tag, the version in the file properties, the executable's name and the
  version the application shows all have to agree.  They do because they come
  from one place: `project(JustViewMD VERSION X.Y.Z ...)` in `CMakeLists.txt`.
  CMake writes that out to `version_generated.h`, which `src/app.rc` (the
  resource version and `OriginalFilename`), `src/main.cpp` (the Options menu and
  the update check) and the target's `OUTPUT_NAME` all use.
- **The version bumps itself.**  `build.bat` runs `tools/version.ps1`, which adds
  one to the patch number in that line before configuring.  `--keep-version`
  rebuilds the number already there and `--version X.Y.Z` sets it outright.
  Bumping a release is a build, a tag and the upload of the file in `dist\`,
  never a hand edit of the number.  (A bare `cmake --build` builds whatever
  number the file holds; releases go through `build.bat`.)
- The update check reads `releases/latest` of `finnuen/JustViewMD`, so a release
  has to be published (not a draft) before the application can see it.  Release
  tags are `vX.Y.Z`.

## Building

- MinGW-w64 (GCC) and MSVC are both supported: `build.bat` on Windows, or
  `cmake -B build` + `cmake --build build`.
- The only dependencies are the Windows SDK and the Microsoft Edge WebView2 SDK,
  which CMake fetches.  Do not add a third-party library that has to be shipped
  beside the executable: the program is one `.exe` on purpose, and it must keep
  linking nothing but system DLLs.
- **Build-only verification.**  Compiling is the check that is expected here;
  the GUI is smoke-tested by hand.

## The pieces worth knowing before touching them

- The page never talks to the network.  `assets/` is served from
  `https://app.local`, pictures are fetched by the host and served from
  `https://cache.local`, and the update check is a host request too.  Any new
  feature that needs the network belongs in the host, not in `assets/`.
- Settings and the session live in `%LOCALAPPDATA%\JustViewMD\settings.ini`,
  written atomically.  Nothing goes in the registry: the registry is only ever
  *read* to migrate options from releases that predate the settings file.
- Nothing in the program deletes a cached picture.  The Options menu reports how
  much is cached and opens the folder; what stays and what goes is the user's
  decision in Explorer.
- The update check must never interrupt.  It runs in the background when the
  window opens and reports itself only in the Options menu; a toast is shown
  only when the user asked for the check.
- Two icons, never swapped: `IDI_APPICON` (101) is the first icon group in the
  file and is what Explorer shows for the executable itself, `IDI_DOCICON` (102)
  is the sheet marked `.MD` and belongs to the documents.  Windows takes a
  document's icon from the registration it resolved the handler through, and an
  "Open with" entry is keyed by the executable's name - which carries the
  version - so `RefreshDocumentIcons()` in `src/main.cpp` rewrites the icon of
  the ProgID and of every `Applications\JustViewMD*.exe` entry on each start.
  Keep that call: without it a rename sends `.md` files back to the app badge.
