// JustViewMD resource identifiers.
#ifndef JUSTVIEWMD_RESOURCE_H
#define JUSTVIEWMD_RESOURCE_H

// The application icon: window, taskbar, Explorer, title bar.
#define IDI_APPICON 101

// The document icon that Markdown files show once JustViewMD is their default
// handler (registered as "<exe>,-IDI_DOCICON").
#define IDI_DOCICON 102

// MinGW builds compile WebView2Loader.dll into the executable and load it from
// an unpacked copy at run time: the Visual C++ static loader cannot be linked
// with MinGW.  MSVC links the static loader and does not use this resource.
#define IDR_WEBVIEW2_LOADER 2000

#endif  // JUSTVIEWMD_RESOURCE_H
