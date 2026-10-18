// ===========================================================================
//  JustViewMD - a fast, offline Markdown live-preview viewer for Windows.
//
//  Native Win32 host around a Microsoft Edge WebView2 view.  The host owns the
//  window, the file system and the shell integration; everything that renders
//  Markdown lives in assets/ and is served to the WebView2 through a virtual
//  host name (https://app.local/) so the application works with zero internet
//  access and without any file:// protocol quirks.
//
//  Dependencies: Windows SDK + Microsoft Edge WebView2 SDK.  Nothing else.
//  Build:        see CMakeLists.txt / build.bat.
// ===========================================================================

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00          // Windows 10 or later APIs
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif

// These are normally supplied by the build system; keep the source buildable on
// its own as well.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define STRICT

#include <windows.h>
#include <shellapi.h>      // DragAcceptFiles / DragQueryFileW / ShellExecuteW
#include <shlwapi.h>       // PathFindFileNameW / PathCreateFromUrlW / SHDeleteKeyW
#include <shlobj.h>        // SHGetKnownFolderPath
#include <knownfolders.h>  // FOLDERID_LocalAppData
#include <commdlg.h>       // GetOpenFileNameW / GetSaveFileNameW
#include <dwmapi.h>        // DwmSetWindowAttribute
#include <objbase.h>       // OleInitialize / CoTaskMemFree / IsEqualIID
#include <winhttp.h>       // WinHttpOpen / WinHttpCrackUrl (remote images)

#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdlib>
#include <deque>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#if defined(__GNUC__)
// The WebView2 SDK header is generated for MSVC and contains a few
// "#pragma warning" statements that GCC does not know about.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunknown-pragmas"
#endif
#include <WebView2.h>
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

#include "resource.h"
#include "assets_manifest.h"
// The version numbers, written by CMake from the one version in CMakeLists.txt.
#include "version_generated.h"

namespace {

// ===========================================================================
//  1. Constants
// ===========================================================================

constexpr wchar_t kAppName[]        = L"JustViewMD";
constexpr wchar_t kWindowClass[]    = L"JustViewMD.MainWindow";
constexpr wchar_t kUntitledName[]   = L"Untitled.md";
constexpr wchar_t kAppVersion[]     = JVMD_VERSION_SHORT_WIDE;  // "1.0.0"

// The WebView2 virtual host.  assets/ is mapped to https://app.local/ so the
// front end behaves exactly like a web site while never touching the network.
constexpr wchar_t kVirtualHost[]    = L"app.local";
constexpr wchar_t kStartUrl[]       = L"https://app.local/index.html";
constexpr wchar_t kAssetOrigin[]    = L"https://app.local";

// A document may point at pictures on the web.  The host downloads each one
// once into %LOCALAPPDATA%\JustViewMD\cache and serves it to the page from
// https://cache.local/ as if it had always been local: the embedded browser
// never talks to the network itself, a document with online pictures keeps
// working offline once it has been seen, and opening one cannot report the
// reader's address to whoever hosts the images.
constexpr wchar_t kImageCacheHost[]   = L"cache.local";
constexpr wchar_t kImageCacheOrigin[] = L"https://cache.local";
constexpr wchar_t kImageCacheFolder[] = L"cache";
constexpr size_t  kMaxImageBytes      = 32u * 1024u * 1024u;  // per picture
constexpr size_t  kMaxImageDownloads  = 4;                    // at the same time
constexpr UINT    kImageDownloadedMessage = WM_APP + 1;

// The releases published on GitHub are where a newer version comes from.  The
// check behind them is the only request this program makes besides the pictures
// a document asks for; like those it is made by the host, never by the page.
constexpr wchar_t kReleasesApiUrl[]  = L"https://api.github.com/repos/finnuen/JustViewMD/releases/latest";
constexpr wchar_t kReleasesPageUrl[] = L"https://github.com/finnuen/JustViewMD/releases/latest";
constexpr size_t  kMaxReleaseBytes   = 256u * 1024u;  // the answer is a few kB
constexpr UINT    kUpdateCheckedMessage = WM_APP + 2;

constexpr wchar_t kAssetsFolder[]   = L"assets";
constexpr wchar_t kWelcomeFile[]    = L"welcome.md";

constexpr int   kDefaultWindowWidth  = 1360;
constexpr int   kDefaultWindowHeight = 860;
constexpr int   kMinWindowWidth      = 720;
constexpr int   kMinWindowHeight     = 420;

constexpr double kMinZoomFactor = 0.5;
constexpr double kMaxZoomFactor = 3.0;
constexpr double kZoomStep      = 0.1;

// Refuse to open anything bigger than this: a Markdown viewer is not a hex
// editor and the WebView2 renderer should not be asked to host a monster.
constexpr ULONGLONG kMaxDocumentBytes = 64ull * 1024ull * 1024ull;

// A NUL byte inside the first bytes of a file means "not text".
constexpr DWORD kBinarySniffBytes = 8192;

// Fallback document when assets/welcome.md is unavailable.
constexpr wchar_t kFallbackWelcome[] =
    L"# JustViewMD\n"
    L"\n"
    L"Start typing \x2014 the preview updates as you go.\n"
    L"\n"
    L"* **Ctrl+O** open a file, **Ctrl+S** save, **Ctrl+Shift+S** save as.\n"
    L"* Drop a `.md` file anywhere on this window to open it.\n"
    L"* **Ctrl+plus / Ctrl+minus / Ctrl+0** change the zoom level.\n";

// Chromium switches.  They keep the embedded browser quiet: no background
// networking, no component updates, no sign-in, no first-run behaviour, and
// no Edge side panels.  Everything the app itself needs is local.
constexpr wchar_t kBrowserArguments[] =
    L"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,"
    L"EdgeCollections,msEdgeTranslate,msEdgeIdentitySidebar,msEdgeSidebar "
    L"--disable-background-networking "
    L"--disable-component-update "
    L"--disable-default-apps "
    L"--disable-sync "
    L"--disable-domain-reliability "
    L"--disable-client-side-phishing-detection "
    L"--no-first-run "
    L"--no-default-browser-check "
    L"--allow-file-access-from-files";

// The loader parses ICoreWebView2EnvironmentOptions::TargetCompatibleBrowserVersion
// and refuses to start the engine when the property is empty or malformed - it
// answers E_INVALIDARG, which says nothing about the real problem.  The value
// below is the product version of the WebView2 SDK this build was configured
// against (JVMD_WEBVIEW2_VERSION in CMakeLists.txt); it means "run on a runtime
// at least this new".  Every API the app uses, including the feature probes in
// SetupWebViewAfterControllerCreated(), exists in runtimes years older.
constexpr wchar_t kTargetBrowserVersion[] = L"154.0.4258.31";

// Second attempt, used when the runtime installed on the machine is older than
// the version above.  85.0.564.0 was the first WebView2 runtime ever shipped,
// so this asks for nothing beyond "any runtime at all"; the interface probes
// take care of the gaps that leaves behind.
constexpr wchar_t kOldestBrowserVersion[] = L"85.0.564.0";

// Window colours (BGR for DWM, RGB for GDI).
constexpr COLORREF kDarkWindowColor  = RGB(0x18, 0x1A, 0x21);
constexpr COLORREF kLightWindowColor = RGB(0xFF, 0xFF, 0xFF);

// DWM attributes: 20 is the current value for the dark title bar, 19 was used
// by the first Windows 10 builds that supported it.
constexpr DWORD kDwmwaImmersiveDarkMode       = 20;
constexpr DWORD kDwmwaImmersiveDarkModeLegacy = 19;
constexpr DWORD kDwmwaCaptionColor            = 35;
constexpr DWORD kDwmwaBorderColor             = 34;

// Timer used when the page does not answer a close request (hung renderer).
constexpr UINT_PTR kTimerCloseFallback      = 1;
constexpr UINT     kCloseFallbackMilliseconds = 2500;

// Shell integration ---------------------------------------------------------
constexpr wchar_t kVerbKeyPrefix[]  = L"Software\\Classes\\SystemFileAssociations\\";
constexpr wchar_t kVerbKeySuffix[]  = L"\\shell\\JustViewMD";
constexpr wchar_t kVerbLabel[]      = L"Open with JustViewMD";
const wchar_t* const kRegisteredExtensions[] = { L".md", L".markdown" };

// Default handler registration ----------------------------------------------
// The ProgID below is what the per-extension keys point at when the user asks
// JustViewMD to take over Markdown documents.
constexpr wchar_t kProgId[]            = L"JustViewMD.Document";
constexpr wchar_t kProgIdDescription[] = L"Markdown document";
constexpr wchar_t kClassesKey[]        = L"Software\\Classes\\";
const wchar_t* const kAssociatedExtensions[] = { L".md", L".markdown", L".mdx" };

// Options and the session live in %LOCALAPPDATA%\JustViewMD\settings.ini.  The
// key below is where the releases before that file kept them: it is read once,
// written to the file, and then the values this application owns are removed.
constexpr wchar_t kLegacySettingsKey[] = L"Software\\JustViewMD";
constexpr wchar_t kLegacySessionKey[]  = L"Software\\JustViewMD\\Session";
constexpr wchar_t kSettingsFileName[]  = L"settings.ini";

// ===========================================================================
//  2. Tiny string / path helpers
// ===========================================================================

[[nodiscard]] std::wstring Utf8ToWide(std::string_view utf8) {
    if (utf8.empty()) {
        return {};
    }
    const int sourceLength = static_cast<int>(utf8.size());
    int length = ::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), sourceLength, nullptr, 0);
    UINT codePageFlags = MB_ERR_INVALID_CHARS;
    if (length <= 0) {
        // Not valid UTF-8: decode leniently instead of failing outright.
        codePageFlags = 0;
        length = ::MultiByteToWideChar(CP_UTF8, codePageFlags, utf8.data(), sourceLength, nullptr, 0);
    }
    if (length <= 0) {
        return {};
    }
    std::wstring result(static_cast<size_t>(length), L'\0');
    ::MultiByteToWideChar(CP_UTF8, codePageFlags, utf8.data(), sourceLength, result.data(), length);
    return result;
}

[[nodiscard]] std::string WideToUtf8(std::wstring_view wide) {
    if (wide.empty()) {
        return {};
    }
    const int sourceLength = static_cast<int>(wide.size());
    int length = ::WideCharToMultiByte(CP_UTF8, 0, wide.data(), sourceLength, nullptr, 0, nullptr, nullptr);
    if (length <= 0) {
        return {};
    }
    std::string result(static_cast<size_t>(length), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, wide.data(), sourceLength, result.data(), length, nullptr, nullptr);
    return result;
}

// Escapes a string so it can be embedded in a JSON string literal.
[[nodiscard]] std::wstring JsonEscape(std::wstring_view text) {
    std::wstring escaped;
    escaped.reserve(text.size() + 16);
    for (const wchar_t ch : text) {
        switch (ch) {
        case L'"':  escaped += L"\\\""; break;
        case L'\\': escaped += L"\\\\"; break;
        case L'\b': escaped += L"\\b";  break;
        case L'\f': escaped += L"\\f";  break;
        case L'\n': escaped += L"\\n";  break;
        case L'\r': escaped += L"\\r";  break;
        case L'\t': escaped += L"\\t";  break;
        // U+2028 / U+2029 are line terminators for JavaScript: escape them too.
        case L'\x2028': escaped += L"\\u2028"; break;
        case L'\x2029': escaped += L"\\u2029"; break;
        default:
            if (ch < 0x20) {
                constexpr wchar_t kHex[] = L"0123456789abcdef";
                escaped += L"\\u00";
                escaped += kHex[(static_cast<unsigned>(ch) >> 4) & 0x0F];
                escaped += kHex[static_cast<unsigned>(ch) & 0x0F];
            } else {
                escaped += ch;
            }
            break;
        }
    }
    return escaped;
}

[[nodiscard]] std::wstring ExePath() {
    std::wstring buffer(MAX_PATH, L'\0');
    for (;;) {
        const DWORD written = ::GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (written == 0) {
            return {};
        }
        if (written < buffer.size()) {
            buffer.resize(written);
            return buffer;
        }
        buffer.resize(buffer.size() * 2);
    }
}

[[nodiscard]] std::wstring DirectoryOf(std::wstring_view path) {
    const size_t slash = path.find_last_of(L"\\/");
    if (slash == std::wstring_view::npos) {
        return {};
    }
    return std::wstring(path.substr(0, slash));
}

[[nodiscard]] std::wstring FileNameOf(std::wstring_view path) {
    const size_t slash = path.find_last_of(L"\\/");
    if (slash == std::wstring_view::npos) {
        return std::wstring(path);
    }
    return std::wstring(path.substr(slash + 1));
}

[[nodiscard]] std::wstring JoinPath(std::wstring_view directory, std::wstring_view name) {
    std::wstring result(directory);
    if (!result.empty() && result.back() != L'\\' && result.back() != L'/') {
        result += L'\\';
    }
    result += name;
    return result;
}

[[nodiscard]] bool FileExists(std::wstring_view path) {
    const DWORD attributes = ::GetFileAttributesW(std::wstring(path).c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

[[nodiscard]] bool DirectoryExists(std::wstring_view path) {
    const DWORD attributes = ::GetFileAttributesW(std::wstring(path).c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

// True when the file extension is one this application is meant to open.
[[nodiscard]] bool HasTextExtension(std::wstring_view lowerPath) {
    constexpr std::wstring_view kExtensions[] = {
        L".md", L".markdown", L".mdown", L".mkd", L".mkdn", L".mdx", L".txt", L".text", L".log"
    };
    for (const std::wstring_view extension : kExtensions) {
        if (lowerPath.size() > extension.size() &&
            lowerPath.compare(lowerPath.size() - extension.size(), extension.size(), extension) == 0) {
            return true;
        }
    }
    return false;
}

[[nodiscard]] std::wstring ToLower(std::wstring_view text) {
    std::wstring lower(text);
    if (!lower.empty()) {
        ::CharLowerBuffW(lower.data(), static_cast<DWORD>(lower.size()));
    }
    return lower;
}

// %LOCALAPPDATA%.  The WebView2 user data folder lives below it.
[[nodiscard]] std::wstring LocalAppDataDirectory() {
    PWSTR raw = nullptr;
    if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &raw)) && raw != nullptr) {
        std::wstring path(raw);
        ::CoTaskMemFree(raw);
        return path;
    }
    if (raw != nullptr) {
        ::CoTaskMemFree(raw);
    }
    // Extremely unlikely, but never fail silently: fall back to the exe folder.
    return DirectoryOf(ExePath());
}

// Creates a directory tree, one component at a time.
[[nodiscard]] bool EnsureDirectory(const std::wstring& path) {
    if (path.empty() || DirectoryExists(path)) {
        return true;
    }
    const std::wstring parent = DirectoryOf(path);
    if (!parent.empty() && parent != path && !EnsureDirectory(parent)) {
        return false;
    }
    if (::CreateDirectoryW(path.c_str(), nullptr)) {
        return true;
    }
    return ::GetLastError() == ERROR_ALREADY_EXISTS;
}

void ShowErrorBox(HWND owner, std::wstring_view message, std::wstring_view title = kAppName) {
    const std::wstring messageText(message);
    const std::wstring titleText(title);
    ::MessageBoxW(owner, messageText.c_str(), titleText.c_str(), MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

// Set by --log before anything else runs; DebugLog appends to it when non-empty.
std::wstring g_logPath;

void DebugLog(std::wstring_view text) {
    std::wstring line(L"[JustViewMD] ");
    line += text;

#if defined(_DEBUG)
    ::OutputDebugStringW((line + L"\n").c_str());
#endif

    // A Win32 application has no console, so --log is the only way a user can
    // show us what happened without a debugger attached.
    if (!g_logPath.empty()) {
        SYSTEMTIME now{};
        ::GetLocalTime(&now);
        wchar_t stamp[64] = {};
        (void)::swprintf_s(stamp, L"%04u-%02u-%02u %02u:%02u:%02u.%03u ",
                           now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond,
                           now.wMilliseconds);
        line.insert(0, stamp);
        line += L"\r\n";

        const HANDLE file = ::CreateFileW(g_logPath.c_str(), FILE_APPEND_DATA,
                                          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
                                          FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE) {
            const DWORD bytes = static_cast<DWORD>(line.size() * sizeof(wchar_t));
            DWORD written = 0;
            (void)::WriteFile(file, line.data(), bytes, &written, nullptr);
            ::CloseHandle(file);
        }
    }
}

// ===========================================================================
//  3. Minimal JSON reader for the WebView2 message channel
//
//  The page only ever sends flat objects such as {"type":"save"} or
//  {"type":"snapshot","content":"..."}, so a compact recursive-descent reader
//  is enough - but it does honour string escapes, which keeps a message whose
//  *payload* happens to contain the word "type" from being misread.
// ===========================================================================

class JsonReader {
public:
    explicit JsonReader(std::wstring_view text) noexcept : m_text(text) {}

    [[nodiscard]] std::wstring GetString(std::wstring_view key, std::wstring_view fallback = {}) const {
        size_t position = 0;
        if (!FindValue(key, position) || position >= m_text.size() || m_text[position] != L'"') {
            return std::wstring(fallback);
        }
        return ParseString(position);
    }

    [[nodiscard]] bool GetBool(std::wstring_view key, bool fallback = false) const {
        size_t position = 0;
        if (!FindValue(key, position)) {
            return fallback;
        }
        if (m_text.compare(position, 4, L"true") == 0) {
            return true;
        }
        if (m_text.compare(position, 5, L"false") == 0) {
            return false;
        }
        if (position < m_text.size() && (m_text[position] == L'0' || m_text[position] == L'1')) {
            return m_text[position] == L'1';
        }
        return fallback;
    }

    [[nodiscard]] double GetNumber(std::wstring_view key, double fallback = 0.0) const {
        size_t position = 0;
        if (!FindValue(key, position)) {
            return fallback;
        }
        const std::wstring numberText = ParseNumber(position);
        if (numberText.empty()) {
            return fallback;
        }
        return std::wcstod(numberText.c_str(), nullptr);
    }

private:
    // Locates the value that belongs to "key" at the top level of the object.
    [[nodiscard]] bool FindValue(std::wstring_view key, size_t& valuePosition) const {
        size_t position = 0;
        SkipWhitespace(position);
        if (position >= m_text.size() || m_text[position] != L'{') {
            return false;
        }
        ++position;
        for (;;) {
            SkipWhitespace(position);
            if (position >= m_text.size()) {
                return false;
            }
            if (m_text[position] == L'}') {
                return false;
            }
            if (m_text[position] != L'"') {
                return false;
            }
            const std::wstring name = ParseString(position);
            SkipWhitespace(position);
            if (position >= m_text.size() || m_text[position] != L':') {
                return false;
            }
            ++position;
            SkipWhitespace(position);
            if (name == key) {
                valuePosition = position;
                return true;
            }
            if (!SkipValue(position, 0)) {
                return false;
            }
            SkipWhitespace(position);
            if (position < m_text.size() && m_text[position] == L',') {
                ++position;
                continue;
            }
            return false;
        }
    }

    void SkipWhitespace(size_t& position) const noexcept {
        while (position < m_text.size()) {
            const wchar_t ch = m_text[position];
            if (ch == L' ' || ch == L'\t' || ch == L'\n' || ch == L'\r') {
                ++position;
            } else {
                break;
            }
        }
    }

    // Parses a quoted string starting at `position` and advances past it.
    [[nodiscard]] std::wstring ParseString(size_t& position) const {
        std::wstring result;
        if (position >= m_text.size() || m_text[position] != L'"') {
            return result;
        }
        ++position;
        while (position < m_text.size()) {
            const wchar_t ch = m_text[position++];
            if (ch == L'"') {
                break;
            }
            if (ch != L'\\') {
                result += ch;
                continue;
            }
            if (position >= m_text.size()) {
                break;
            }
            const wchar_t escape = m_text[position++];
            switch (escape) {
            case L'"':  result += L'"';  break;
            case L'\\': result += L'\\'; break;
            case L'/':  result += L'/';  break;
            case L'b':  result += L'\b'; break;
            case L'f':  result += L'\f'; break;
            case L'n':  result += L'\n'; break;
            case L'r':  result += L'\r'; break;
            case L't':  result += L'\t'; break;
            case L'u': {
                unsigned code = 0;
                for (int digit = 0; digit < 4; ++digit) {
                    if (position >= m_text.size()) {
                        return result;
                    }
                    const wchar_t hex = m_text[position++];
                    unsigned value = 0;
                    if (hex >= L'0' && hex <= L'9') {
                        value = static_cast<unsigned>(hex - L'0');
                    } else if (hex >= L'a' && hex <= L'f') {
                        value = static_cast<unsigned>(hex - L'a') + 10u;
                    } else if (hex >= L'A' && hex <= L'F') {
                        value = static_cast<unsigned>(hex - L'A') + 10u;
                    } else {
                        return result;
                    }
                    code = (code << 4) | value;
                }
                result += static_cast<wchar_t>(code);
                break;
            }
            default:
                result += escape;
                break;
            }
        }
        return result;
    }

    [[nodiscard]] std::wstring ParseNumber(size_t& position) const {
        const size_t start = position;
        while (position < m_text.size()) {
            const wchar_t ch = m_text[position];
            const bool isNumberChar = (ch >= L'0' && ch <= L'9') || ch == L'-' || ch == L'+' ||
                                      ch == L'.' || ch == L'e' || ch == L'E';
            if (!isNumberChar) {
                break;
            }
            ++position;
        }
        return std::wstring(m_text.substr(start, position - start));
    }

    // Moves past any JSON value; depth guards against pathological input.
    [[nodiscard]] bool SkipValue(size_t& position, int depth) const {
        if (depth > 32 || position >= m_text.size()) {
            return false;
        }
        const wchar_t ch = m_text[position];
        if (ch == L'"') {
            (void)ParseString(position);
            return true;
        }
        if (ch == L'{') {
            return SkipObject(position, depth);
        }
        if (ch == L'[') {
            return SkipArray(position, depth);
        }
        if (m_text.compare(position, 4, L"true") == 0) {
            position += 4;
            return true;
        }
        if (m_text.compare(position, 5, L"false") == 0) {
            position += 5;
            return true;
        }
        if (m_text.compare(position, 4, L"null") == 0) {
            position += 4;
            return true;
        }
        return !ParseNumber(position).empty();
    }

    // An object holds "name": value pairs, an array holds bare values.  Keeping
    // the two apart is what lets a key be found in a document whose values are
    // objects of their own (the releases API is one).
    [[nodiscard]] bool SkipObject(size_t& position, int depth) const {
        ++position;  // past '{'
        for (;;) {
            SkipWhitespace(position);
            if (position >= m_text.size()) {
                return false;
            }
            if (m_text[position] == L'}') {
                ++position;
                return true;
            }
            if (m_text[position] != L'"') {
                return false;
            }
            (void)ParseString(position);  // the name
            SkipWhitespace(position);
            if (position >= m_text.size() || m_text[position] != L':') {
                return false;
            }
            ++position;
            SkipWhitespace(position);
            if (!SkipValue(position, depth + 1)) {
                return false;
            }
            SkipWhitespace(position);
            if (position < m_text.size() && m_text[position] == L',') {
                ++position;
                continue;
            }
            if (position < m_text.size() && m_text[position] == L'}') {
                ++position;
                return true;
            }
            return false;
        }
    }

    [[nodiscard]] bool SkipArray(size_t& position, int depth) const {
        ++position;  // past '['
        for (;;) {
            SkipWhitespace(position);
            if (position >= m_text.size()) {
                return false;
            }
            if (m_text[position] == L']') {
                ++position;
                return true;
            }
            if (!SkipValue(position, depth + 1)) {
                return false;
            }
            SkipWhitespace(position);
            if (position < m_text.size() && m_text[position] == L',') {
                ++position;
                continue;
            }
            if (position < m_text.size() && m_text[position] == L']') {
                ++position;
                return true;
            }
            return false;
        }
    }

    std::wstring_view m_text;
};

// ===========================================================================
//  4. Minimal COM support (deliberately not using WRL: MinGW has no
//     wrl/implements.h, and the two helpers below are all this app needs).
// ===========================================================================

// Interface-implementation base for the WebView2 callbacks.  The object starts
// with a reference count of one that the creator owns; COM calls AddRef/Release
// from there on.
template <typename TDerived, typename TInterface>
class ComHandler : public TInterface {
public:
    ComHandler() noexcept = default;
    ComHandler(const ComHandler&) = delete;
    ComHandler& operator=(const ComHandler&) = delete;

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) noexcept override {
        if (object == nullptr) {
            return E_POINTER;
        }
        *object = nullptr;
        if (::IsEqualIID(riid, IID_IUnknown) || ::IsEqualIID(riid, TDerived::InterfaceId())) {
            *object = static_cast<TInterface*>(static_cast<TDerived*>(this));
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() noexcept override {
        return static_cast<ULONG>(++m_references);
    }

    ULONG STDMETHODCALLTYPE Release() noexcept override {
        const ULONG remaining = static_cast<ULONG>(--m_references);
        if (remaining == 0) {
            delete static_cast<TDerived*>(this);
        }
        return remaining;
    }

private:
    std::atomic<ULONG> m_references{ 1 };
};

// A reference-counted smart pointer for the handful of long lived interfaces.
template <typename T>
class ComPtr {
public:
    ComPtr() noexcept = default;
    ~ComPtr() { Reset(); }

    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;

    ComPtr(ComPtr&& other) noexcept : m_pointer(other.m_pointer) {
        other.m_pointer = nullptr;
    }

    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) {
            Reset();
            m_pointer = other.m_pointer;
            other.m_pointer = nullptr;
        }
        return *this;
    }

    [[nodiscard]] T* Get() const noexcept { return m_pointer; }
    [[nodiscard]] T* operator->() const noexcept { return m_pointer; }
    [[nodiscard]] explicit operator bool() const noexcept { return m_pointer != nullptr; }

    // Returns the address of the internal pointer, releasing a previous value.
    T** Put() noexcept {
        Reset();
        return &m_pointer;
    }

    // Takes ownership of one reference.
    void Attach(T* pointer) noexcept {
        Reset();
        m_pointer = pointer;
    }

    void Reset() noexcept {
        if (m_pointer != nullptr) {
            m_pointer->Release();
            m_pointer = nullptr;
        }
    }

private:
    T* m_pointer = nullptr;
};

// ===========================================================================
//  5. Document I/O
// ===========================================================================

struct Document {
    std::wstring text;
    bool usesCrLf = true;
    bool hadByteOrderMark = false;
};

enum class ReadStatus {
    Ok,
    NotFound,
    TooLarge,
    NotText,
    Failed
};

[[nodiscard]] ReadStatus ReadDocumentFile(const std::wstring& path, Document& document) {
    const HANDLE file = ::CreateFileW(path.c_str(), GENERIC_READ,
                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      nullptr, OPEN_EXISTING,
                                      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return (::GetLastError() == ERROR_FILE_NOT_FOUND || ::GetLastError() == ERROR_PATH_NOT_FOUND)
                   ? ReadStatus::NotFound
                   : ReadStatus::Failed;
    }

    LARGE_INTEGER size{};
    if (!::GetFileSizeEx(file, &size)) {
        ::CloseHandle(file);
        return ReadStatus::Failed;
    }
    if (static_cast<ULONGLONG>(size.QuadPart) > kMaxDocumentBytes) {
        ::CloseHandle(file);
        return ReadStatus::TooLarge;
    }

    std::string bytes(static_cast<size_t>(size.QuadPart), '\0');
    size_t total = 0;
    while (total < bytes.size()) {
        const DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - total, 1u << 20));
        DWORD read = 0;
        if (!::ReadFile(file, bytes.data() + total, chunk, &read, nullptr)) {
            ::CloseHandle(file);
            return ReadStatus::Failed;
        }
        if (read == 0) {
            break;
        }
        total += read;
    }
    ::CloseHandle(file);
    bytes.resize(total);

    document = Document{};
    const unsigned char* raw = reinterpret_cast<const unsigned char*>(bytes.data());

    // Byte order marks -----------------------------------------------------
    if (bytes.size() >= 2 && (raw[0] == 0xFF && raw[1] == 0xFE)) {
        document.hadByteOrderMark = true;
        const size_t characters = (bytes.size() - 2) / 2;
        document.text.assign(reinterpret_cast<const wchar_t*>(bytes.data() + 2), characters);
    } else if (bytes.size() >= 2 && (raw[0] == 0xFE && raw[1] == 0xFF)) {
        document.hadByteOrderMark = true;
        const size_t characters = (bytes.size() - 2) / 2;
        document.text.reserve(characters);
        for (size_t index = 0; index < characters; ++index) {
            const unsigned char high = raw[2 + index * 2];
            const unsigned char low = raw[3 + index * 2];
            document.text += static_cast<wchar_t>((high << 8) | low);
        }
    } else if (bytes.size() >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF) {
        document.hadByteOrderMark = true;
        document.text = Utf8ToWide(std::string_view(bytes).substr(3));
    } else {
        // Binary sniffing: a NUL byte in the head of a text file is not normal.
        const size_t sniffLength = std::min<size_t>(bytes.size(), kBinarySniffBytes);
        for (size_t index = 0; index < sniffLength; ++index) {
            if (bytes[index] == '\0') {
                return ReadStatus::NotText;
            }
        }
        document.text = Utf8ToWide(bytes);
    }

    document.usesCrLf = document.text.find(L"\r\n") != std::wstring::npos;
    return ReadStatus::Ok;
}

// Rewrites the buffer so that it uses the same line endings the file had.
[[nodiscard]] std::wstring ApplyLineEndingStyle(std::wstring_view text, bool crlf) {
    std::wstring result;
    result.reserve(text.size() + text.size() / 16);
    for (size_t index = 0; index < text.size(); ++index) {
        const wchar_t ch = text[index];
        if (ch == L'\r') {
            const bool followedByLineFeed = (index + 1 < text.size() && text[index + 1] == L'\n');
            if (crlf) {
                result += L"\r\n";
            } else {
                result += L'\n';
            }
            if (followedByLineFeed) {
                ++index;
            }
        } else if (ch == L'\n') {
            result += crlf ? L"\r\n" : L"\n";
        } else {
            result += ch;
        }
    }
    return result;
}

[[nodiscard]] bool WriteDocumentFile(const std::wstring& path, std::wstring_view text, bool crlf) {
    const std::string bytes = WideToUtf8(ApplyLineEndingStyle(text, crlf));
    const HANDLE file = ::CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                                      CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    size_t total = 0;
    bool ok = true;
    while (total < bytes.size()) {
        const DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - total, 1u << 20));
        DWORD written = 0;
        if (!::WriteFile(file, bytes.data() + total, chunk, &written, nullptr) || written == 0) {
            ok = false;
            break;
        }
        total += written;
    }
    if (ok) {
        ok = ::FlushFileBuffers(file) != FALSE;
    }
    ::CloseHandle(file);
    return ok;
}

// ===========================================================================
//  5b. Small file helpers for the settings file
// ===========================================================================

// Reads a small text file into memory.  A missing file is not an error with a
// message: the caller falls back to defaults.
[[nodiscard]] bool ReadWholeFile(const std::wstring& path, std::string& bytes) {
    constexpr size_t kMaximumBytes = 1u << 20;   // settings are a few hundred bytes
    const HANDLE file = ::CreateFileW(path.c_str(), GENERIC_READ,
                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    bytes.clear();
    char buffer[16 * 1024];
    bool ok = true;
    for (;;) {
        DWORD read = 0;
        if (!::ReadFile(file, buffer, sizeof(buffer), &read, nullptr)) {
            ok = false;
            break;
        }
        if (read == 0) {
            break;
        }
        bytes.append(buffer, read);
        if (bytes.size() > kMaximumBytes) {
            ok = false;
            break;
        }
    }
    ::CloseHandle(file);
    if (!ok) {
        bytes.clear();
    }
    return ok;
}

// Replaces a file through a temporary name: a crash or a full disk leaves
// either the old contents or the new ones on disk, never half of each.
[[nodiscard]] bool WriteWholeFileAtomically(const std::wstring& path, std::string_view bytes) {
    const std::wstring temporary = path + L".tmp";
    const HANDLE file = ::CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr,
                                      CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    size_t total = 0;
    bool ok = true;
    while (total < bytes.size()) {
        const DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - total, 1u << 20));
        DWORD written = 0;
        if (!::WriteFile(file, bytes.data() + total, chunk, &written, nullptr) || written == 0) {
            ok = false;
            break;
        }
        total += written;
    }
    if (ok) {
        ok = ::FlushFileBuffers(file) != FALSE;
    }
    ::CloseHandle(file);
    if (!ok) {
        (void)::DeleteFileW(temporary.c_str());
        return false;
    }
    if (!::MoveFileExW(temporary.c_str(), path.c_str(),
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        (void)::DeleteFileW(temporary.c_str());
        return false;
    }
    return true;
}

// ===========================================================================
//  5c. The front end embedded in the executable
// ===========================================================================
//
// Every file below assets/ is compiled into the executable as an RCDATA
// resource; assets_manifest.h lists the ids and the relative paths.  A version
// unpacks them once into %LOCALAPPDATA%\JustViewMD\assets\<version> and the
// embedded browser serves that folder.  Unpacking on every start would work
// too, but it would put four megabytes of writes in front of every launch for
// no gain.
//
// The unpacked copy records the size and the timestamp of the executable that
// wrote it.  A release never changes below a version, but a development build
// does, and the marker makes the next start replace the copy instead of
// serving yesterday's front end.

constexpr wchar_t kAssetsMarker[] = L".jvmd-assets";

struct FileIdentity {
    unsigned long long size = 0;
    unsigned long long modified = 0;  // FILETIME: 100 ns since 1601
};

[[nodiscard]] bool ReadFileIdentity(const std::wstring& path, FileIdentity& identity) {
    const HANDLE file = ::CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    BY_HANDLE_FILE_INFORMATION information{};
    const bool ok = ::GetFileInformationByHandle(file, &information) != FALSE;
    ::CloseHandle(file);
    if (!ok) {
        return false;
    }
    identity.size = (static_cast<unsigned long long>(information.nFileSizeHigh) << 32) |
                    static_cast<unsigned long long>(information.nFileSizeLow);
    identity.modified =
        (static_cast<unsigned long long>(information.ftLastWriteTime.dwHighDateTime) << 32) |
        static_cast<unsigned long long>(information.ftLastWriteTime.dwLowDateTime);
    return true;
}

// %LOCALAPPDATA%\JustViewMD\assets
[[nodiscard]] std::wstring EmbeddedAssetsRoot() {
    return JoinPath(JoinPath(LocalAppDataDirectory(), kAppName), kAssetsFolder);
}

// %LOCALAPPDATA%\JustViewMD\assets\<version>
[[nodiscard]] std::wstring EmbeddedAssetsDirectory() {
    return JoinPath(EmbeddedAssetsRoot(), jvmd_assets::kCacheVersion);
}

[[nodiscard]] DWORD EmbeddedAssetSize(unsigned id) {
    const HRSRC resource = ::FindResourceW(::GetModuleHandleW(nullptr), MAKEINTRESOURCEW(id), RT_RCDATA);
    return resource == nullptr ? 0 : ::SizeofResource(::GetModuleHandleW(nullptr), resource);
}

// "1 <size> <modified>\n" -- readable on purpose, it explains itself in a bug
// report.  Anything that does not parse simply invalidates the copy.
[[nodiscard]] bool ReadAssetsMarker(const std::wstring& directory, FileIdentity& identity) {
    std::string bytes;
    if (!ReadWholeFile(JoinPath(directory, kAssetsMarker), bytes)) {
        return false;
    }
    const std::wstring text = Utf8ToWide(bytes);
    const wchar_t* cursor = text.c_str();
    wchar_t* end = nullptr;
    const unsigned long long version = ::wcstoull(cursor, &end, 10);
    if (end == cursor || version != 1) {
        return false;
    }
    cursor = end;
    const unsigned long long size = ::wcstoull(cursor, &end, 10);
    if (end == cursor) {
        return false;
    }
    cursor = end;
    const unsigned long long modified = ::wcstoull(cursor, &end, 10);
    if (end == cursor) {
        return false;
    }
    identity.size = size;
    identity.modified = modified;
    return true;
}

[[nodiscard]] bool WriteAssetsMarker(const std::wstring& directory, const FileIdentity& identity) {
    const std::string text = "1 " + std::to_string(identity.size) + " " +
                             std::to_string(identity.modified) + "\n";
    return WriteWholeFileAtomically(JoinPath(directory, kAssetsMarker), text);
}

// The marker proves who wrote the copy; this proves that every file of it is
// still there with the size it was written with, so a half-deleted cache
// repairs itself on the next start.
[[nodiscard]] bool AssetsCacheMatches(const std::wstring& directory, const FileIdentity& executable) {
    FileIdentity written{};
    if (!ReadAssetsMarker(directory, written)) {
        return false;
    }
    if (written.size != executable.size || written.modified != executable.modified) {
        return false;
    }
    for (const jvmd_assets::Entry& entry : jvmd_assets::kEntries) {
        const std::wstring path = JoinPath(directory, entry.path);
        WIN32_FILE_ATTRIBUTE_DATA data{};
        if (!::GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) {
            return false;
        }
        if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            return false;
        }
        const unsigned long long size =
            (static_cast<unsigned long long>(data.nFileSizeHigh) << 32) |
            static_cast<unsigned long long>(data.nFileSizeLow);
        if (size != static_cast<unsigned long long>(EmbeddedAssetSize(entry.id))) {
            return false;
        }
    }
    return true;
}

// Writes bytes into a file the application owns.  Unlike
// WriteWholeFileAtomically this neither flushes nor renames; the asset cache is
// verified on the next start, so a torn file there is repaired anyway.
[[nodiscard]] bool WriteFileDirect(const std::wstring& path, const void* bytes, size_t size) {
    const HANDLE file = ::CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                                      CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    size_t total = 0;
    bool ok = true;
    while (total < size) {
        const DWORD chunk = static_cast<DWORD>(std::min<size_t>(size - total, 1u << 20));
        DWORD written = 0;
        if (!::WriteFile(file, static_cast<const char*>(bytes) + total, chunk, &written, nullptr) ||
            written == 0) {
            ok = false;
            break;
        }
        total += written;
    }
    ::CloseHandle(file);
    return ok;
}

[[nodiscard]] bool ExtractEmbeddedAssets(const std::wstring& directory) {
    const HMODULE module = ::GetModuleHandleW(nullptr);
    for (const jvmd_assets::Entry& entry : jvmd_assets::kEntries) {
        const HRSRC resource = ::FindResourceW(module, MAKEINTRESOURCEW(entry.id), RT_RCDATA);
        if (resource == nullptr) {
            DebugLog(L"Embedded front end: missing resource " + std::to_wstring(entry.id));
            return false;
        }
        const DWORD size = ::SizeofResource(module, resource);
        const HGLOBAL loaded = ::LoadResource(module, resource);
        const void* bytes = loaded != nullptr ? ::LockResource(loaded) : nullptr;
        if (bytes == nullptr) {
            DebugLog(L"Embedded front end: cannot read resource " + std::to_wstring(entry.id));
            return false;
        }
        const std::wstring path = JoinPath(directory, entry.path);
        if (!EnsureDirectory(DirectoryOf(path))) {
            DebugLog(L"Embedded front end: cannot create the folder for " + path);
            return false;
        }
        // No flush, no temporary file: the next start checks every size and
        // rewrites whatever a crash cut short, so durability would only cost
        // a disk shuffle per file here.
        if (!WriteFileDirect(path, bytes, size)) {
            DebugLog(L"Embedded front end: cannot write " + path);
            return false;
        }
    }
    return true;
}

[[nodiscard]] bool DeleteDirectoryTree(const std::wstring& path) {
    WIN32_FIND_DATAW data{};
    const HANDLE search = ::FindFirstFileW(JoinPath(path, L"*").c_str(), &data);
    if (search != INVALID_HANDLE_VALUE) {
        do {
            if (std::wcscmp(data.cFileName, L".") == 0 || std::wcscmp(data.cFileName, L"..") == 0) {
                continue;
            }
            const std::wstring child = JoinPath(path, data.cFileName);
            if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
                (void)DeleteDirectoryTree(child);
            } else {
                (void)::DeleteFileW(child.c_str());
            }
        } while (::FindNextFileW(search, &data));
        ::FindClose(search);
    }
    return ::RemoveDirectoryW(path.c_str()) != FALSE;
}

// Copies of older versions are dead weight.  Only folders this application
// wrote (they carry the marker) are touched.
void RemoveOlderAssetCopies(const std::wstring& current) {
    WIN32_FIND_DATAW data{};
    const HANDLE search = ::FindFirstFileW(JoinPath(EmbeddedAssetsRoot(), L"*").c_str(), &data);
    if (search == INVALID_HANDLE_VALUE) {
        return;
    }
    std::vector<std::wstring> stale;
    do {
        if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
            continue;
        }
        if (std::wcscmp(data.cFileName, L".") == 0 || std::wcscmp(data.cFileName, L"..") == 0) {
            continue;
        }
        const std::wstring path = JoinPath(EmbeddedAssetsRoot(), data.cFileName);
        if (::CompareStringOrdinal(path.c_str(), -1, current.c_str(), -1, TRUE) == CSTR_EQUAL) {
            continue;
        }
        if (!FileExists(JoinPath(path, kAssetsMarker))) {
            continue;
        }
        stale.push_back(path);
    } while (::FindNextFileW(search, &data));
    ::FindClose(search);
    for (const std::wstring& path : stale) {
        DebugLog(L"Removing the old front end at " + path);
        (void)DeleteDirectoryTree(path);
    }
}

// Returns the folder to serve, or an empty string when the copy cannot be made.
[[nodiscard]] std::wstring PrepareEmbeddedAssets() {
    const std::wstring directory = EmbeddedAssetsDirectory();
    FileIdentity executable{};
    if (!ReadFileIdentity(ExePath(), executable)) {
        DebugLog(L"Embedded front end: cannot read " + ExePath());
        return {};
    }
    if (AssetsCacheMatches(directory, executable)) {
        return directory;
    }
    const ULONGLONG started = ::GetTickCount64();
    if (!ExtractEmbeddedAssets(directory)) {
        // Two instances starting at once can race on the same files.  If the
        // other one finished, its copy is exactly what this one wanted.
        if (AssetsCacheMatches(directory, executable)) {
            return directory;
        }
        return {};
    }
    if (!WriteAssetsMarker(directory, executable)) {
        // The files are complete; only the freshness marker failed.  Serving
        // them is still right, so this is not an error.
        DebugLog(L"Embedded front end: cannot write the marker in " + directory);
    }
    DebugLog(L"Unpacked " + std::to_wstring(jvmd_assets::kEntryCount) + L" front end files to " +
             directory + L" in " + std::to_wstring(::GetTickCount64() - started) + L" ms");
    RemoveOlderAssetCopies(directory);
    return directory;
}

// ===========================================================================
//  5d. The WebView2 loader
// ===========================================================================
//
// WebView2Loader.dll is the one DLL the application needs.  The MSVC build
// links WebView2LoaderStatic.lib and is done with it; MinGW cannot link that
// library (it is Visual C++ code and wants that runtime), so the DLL is
// compiled into the executable and unpacked into
// %LOCALAPPDATA%\JustViewMD\bin\<version> on first use.  It is loaded by
// absolute path, so no DLL search order is involved.

#if defined(_MSC_VER)

// The linker resolves the real function.
[[nodiscard]] HRESULT CreateEnvironmentWithOptions(
    PCWSTR browserExecutableFolder, PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions* options,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* completedHandler) {
    return ::CreateCoreWebView2EnvironmentWithOptions(
        browserExecutableFolder, userDataFolder, options, completedHandler);
}

#else

using CreateEnvironmentWithOptionsFn = HRESULT(STDAPICALLTYPE*)(
    PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);

CreateEnvironmentWithOptionsFn g_createEnvironmentWithOptions = nullptr;

[[nodiscard]] std::wstring WebView2LoaderDirectory() {
    return JoinPath(JoinPath(JoinPath(LocalAppDataDirectory(), kAppName), L"bin"),
                    std::wstring(jvmd_assets::kCacheVersion) + L"-" + jvmd_assets::kLoaderVersion);
}

// Writes the embedded DLL over whatever is at the path.
[[nodiscard]] bool WriteWebView2Loader(const std::wstring& path) {
    const HMODULE module = ::GetModuleHandleW(nullptr);
    const HRSRC resource = ::FindResourceW(module, MAKEINTRESOURCEW(IDR_WEBVIEW2_LOADER), RT_RCDATA);
    if (resource == nullptr) {
        DebugLog(L"WebView2 loader: the executable has no loader resource");
        return false;
    }
    const DWORD size = ::SizeofResource(module, resource);
    const HGLOBAL loaded = ::LoadResource(module, resource);
    const void* bytes = loaded != nullptr ? ::LockResource(loaded) : nullptr;
    if (bytes == nullptr) {
        DebugLog(L"WebView2 loader: cannot read the loader resource");
        return false;
    }
    const std::wstring directory = DirectoryOf(path);
    if (!EnsureDirectory(directory)) {
        DebugLog(L"WebView2 loader: cannot create " + directory);
        return false;
    }
    return WriteFileDirect(path, bytes, size);
}

// FNV-1a.  The loader is only ever handed to Windows when the unpacked file is
// byte for byte the embedded one; a truncated or damaged DLL is rewritten
// first (a broken image can otherwise sit in an antivirus scan for seconds).
[[nodiscard]] unsigned long long HashBytes(const void* bytes, size_t size) {
    const auto* data = static_cast<const unsigned char*>(bytes);
    unsigned long long hash = 1469598103934665603ull;
    for (size_t index = 0; index < size; ++index) {
        hash ^= data[index];
        hash *= 1099511628211ull;
    }
    return hash;
}

[[nodiscard]] bool WebView2LoaderIsCurrent(const std::wstring& path) {
    const HMODULE module = ::GetModuleHandleW(nullptr);
    const HRSRC resource = ::FindResourceW(module, MAKEINTRESOURCEW(IDR_WEBVIEW2_LOADER), RT_RCDATA);
    if (resource == nullptr) {
        return false;
    }
    const DWORD size = ::SizeofResource(module, resource);
    const HGLOBAL loaded = ::LoadResource(module, resource);
    const void* bytes = loaded != nullptr ? ::LockResource(loaded) : nullptr;
    if (bytes == nullptr) {
        return false;
    }
    std::string existing;
    if (!ReadWholeFile(path, existing) || existing.size() != size) {
        return false;
    }
    return HashBytes(existing.data(), existing.size()) == HashBytes(bytes, size);
}

[[nodiscard]] CreateEnvironmentWithOptionsFn ResolveWebView2Loader() {
    if (g_createEnvironmentWithOptions != nullptr) {
        return g_createEnvironmentWithOptions;
    }
    const std::wstring path = JoinPath(WebView2LoaderDirectory(), L"WebView2Loader.dll");
    if (!WebView2LoaderIsCurrent(path)) {
        if (!WriteWebView2Loader(path)) {
            return nullptr;
        }
        DebugLog(L"Unpacked the WebView2 loader to " + path);
    }
    const HMODULE module = ::LoadLibraryW(path.c_str());
    if (module == nullptr) {
        DebugLog(L"WebView2 loader: cannot load " + path + L" (" +
                 std::to_wstring(::GetLastError()) + L")");
        return nullptr;
    }
    const FARPROC address = ::GetProcAddress(module, "CreateCoreWebView2EnvironmentWithOptions");
    if (address == nullptr) {
        DebugLog(L"WebView2 loader: " + path + L" has no CreateCoreWebView2EnvironmentWithOptions");
        return nullptr;
    }
    // Through void*: a direct FARPROC-to-typed-pointer cast trips
    // -Wcast-function-type although the signature is the one the DLL exports.
    g_createEnvironmentWithOptions =
        reinterpret_cast<CreateEnvironmentWithOptionsFn>(reinterpret_cast<void*>(address));
    return g_createEnvironmentWithOptions;
}

// Both toolchains call this: MSVC reaches the static loader, MinGW the
// unpacked DLL.
[[nodiscard]] HRESULT CreateEnvironmentWithOptions(
    PCWSTR browserExecutableFolder, PCWSTR userDataFolder,
    ICoreWebView2EnvironmentOptions* options,
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* completedHandler) {
    const CreateEnvironmentWithOptionsFn function = ResolveWebView2Loader();
    if (function == nullptr) {
        return HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND);
    }
    return function(browserExecutableFolder, userDataFolder, options, completedHandler);
}

#endif

// ===========================================================================
//  6. Windows Explorer integration (HKEY_CURRENT_USER only: no admin needed)
// ===========================================================================

[[nodiscard]] std::wstring ShellVerbKey(std::wstring_view extension) {
    std::wstring key(kVerbKeyPrefix);
    key += extension;
    key += kVerbKeySuffix;
    return key;
}

[[nodiscard]] bool WriteRegistryString(HKEY root, const std::wstring& subKey, const wchar_t* valueName,
                                       const std::wstring& value) {
    HKEY key = nullptr;
    if (::RegCreateKeyExW(root, subKey.c_str(), 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &key,
                          nullptr) != ERROR_SUCCESS) {
        return false;
    }
    const DWORD bytes = static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t));
    const LSTATUS status =
        ::RegSetValueExW(key, valueName, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()), bytes);
    ::RegCloseKey(key);
    return status == ERROR_SUCCESS;
}

[[nodiscard]] bool DeleteRegistryTree(HKEY root, const std::wstring& subKey) {
    const LSTATUS status = ::SHDeleteKeyW(root, subKey.c_str());
    return status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND;
}

// Deleting something that is not there counts as success: every caller uses
// this to clean up, and a half-registered application must still unregister
// cleanly.
[[nodiscard]] bool DeleteRegistryValue(HKEY root, const std::wstring& subKey, const wchar_t* valueName) {
    HKEY key = nullptr;
    const LSTATUS opened = ::RegOpenKeyExW(root, subKey.c_str(), 0, KEY_SET_VALUE, &key);
    if (opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND) {
        return true;
    }
    if (opened != ERROR_SUCCESS) {
        return false;
    }
    const LSTATUS status = ::RegDeleteValueW(key, valueName);
    ::RegCloseKey(key);
    return status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND;
}

[[nodiscard]] bool ReadRegistryString(HKEY root, const std::wstring& subKey, const wchar_t* valueName,
                                      std::wstring& value) {
    HKEY key = nullptr;
    if (::RegOpenKeyExW(root, subKey.c_str(), 0, KEY_READ, &key) != ERROR_SUCCESS) {
        return false;
    }
    DWORD type = 0;
    DWORD bytes = 0;
    LSTATUS status = ::RegQueryValueExW(key, valueName, nullptr, &type, nullptr, &bytes);
    if (status != ERROR_SUCCESS || type != REG_SZ || bytes < sizeof(wchar_t) ||
        bytes > 64u * 1024u * sizeof(wchar_t)) {
        ::RegCloseKey(key);
        return false;
    }
    std::wstring buffer(bytes / sizeof(wchar_t) + 1, L'\0');
    status = ::RegQueryValueExW(key, valueName, nullptr, &type, reinterpret_cast<BYTE*>(&buffer[0]), &bytes);
    ::RegCloseKey(key);
    if (status != ERROR_SUCCESS) {
        return false;
    }
    buffer.resize(::wcslen(buffer.c_str()));
    value = buffer;
    return true;
}

[[nodiscard]] bool ReadRegistryDword(HKEY root, const std::wstring& subKey, const wchar_t* valueName,
                                     DWORD& value) {
    HKEY key = nullptr;
    if (::RegOpenKeyExW(root, subKey.c_str(), 0, KEY_READ, &key) != ERROR_SUCCESS) {
        return false;
    }
    DWORD type = 0;
    DWORD bytes = sizeof(DWORD);
    const LSTATUS status =
        ::RegQueryValueExW(key, valueName, nullptr, &type, reinterpret_cast<BYTE*>(&value), &bytes);
    ::RegCloseKey(key);
    return status == ERROR_SUCCESS && type == REG_DWORD && bytes == sizeof(DWORD);
}

[[nodiscard]] bool ReadRegistryMultiString(HKEY root, const std::wstring& subKey, const wchar_t* valueName,
                                           std::vector<std::wstring>& values) {
    values.clear();
    HKEY key = nullptr;
    if (::RegOpenKeyExW(root, subKey.c_str(), 0, KEY_READ, &key) != ERROR_SUCCESS) {
        return false;
    }
    DWORD type = 0;
    DWORD bytes = 0;
    LSTATUS status = ::RegQueryValueExW(key, valueName, nullptr, &type, nullptr, &bytes);
    if (status != ERROR_SUCCESS || type != REG_MULTI_SZ || bytes < sizeof(wchar_t) ||
        bytes > 1024u * 1024u) {
        ::RegCloseKey(key);
        return false;
    }
    std::vector<wchar_t> buffer(bytes / sizeof(wchar_t) + 1, L'\0');
    status = ::RegQueryValueExW(key, valueName, nullptr, &type, reinterpret_cast<BYTE*>(buffer.data()), &bytes);
    ::RegCloseKey(key);
    if (status != ERROR_SUCCESS) {
        return false;
    }
    const wchar_t* cursor = buffer.data();
    const wchar_t* const limit = buffer.data() + (bytes / sizeof(wchar_t));
    while (cursor < limit && *cursor != L'\0') {
        const std::wstring entry(cursor);
        if (!entry.empty()) {
            values.push_back(entry);
        }
        cursor += entry.size() + 1;
    }
    return !values.empty();
}

[[nodiscard]] bool IsShellIntegrationRegistered() {
    for (const wchar_t* extension : kRegisteredExtensions) {
        const std::wstring commandKey = ShellVerbKey(extension) + L"\\command";
        HKEY key = nullptr;
        const LSTATUS status = ::RegOpenKeyExW(HKEY_CURRENT_USER, commandKey.c_str(), 0, KEY_READ, &key);
        if (status != ERROR_SUCCESS) {
            return false;
        }
        ::RegCloseKey(key);
    }
    return true;
}

[[nodiscard]] bool RegisterShellIntegration(bool quiet) {
    const std::wstring executable = ExePath();
    if (executable.empty()) {
        return false;
    }
    const std::wstring quotedExecutable = L"\"" + executable + L"\"";
    const std::wstring iconValue = quotedExecutable + L",0";
    const std::wstring commandValue = quotedExecutable + L" \"%1\"";

    bool ok = true;
    for (const wchar_t* extension : kRegisteredExtensions) {
        const std::wstring verbKey = ShellVerbKey(extension);
        ok = WriteRegistryString(HKEY_CURRENT_USER, verbKey, nullptr, kVerbLabel) && ok;
        ok = WriteRegistryString(HKEY_CURRENT_USER, verbKey, L"Icon", iconValue) && ok;
        ok = WriteRegistryString(HKEY_CURRENT_USER, verbKey, L"MultiSelectModel", L"Single") && ok;
        ok = WriteRegistryString(HKEY_CURRENT_USER, verbKey + L"\\command", nullptr, commandValue) && ok;
    }
    if (!ok && !quiet) {
        ShowErrorBox(nullptr,
                     L"JustViewMD could not add its Explorer context menu entry.\n\n"
                     L"The registry key below HKEY_CURRENT_USER could not be written.");
    }
    return ok;
}

[[nodiscard]] bool UnregisterShellIntegration() {
    bool ok = true;
    for (const wchar_t* extension : kRegisteredExtensions) {
        ok = DeleteRegistryTree(HKEY_CURRENT_USER, ShellVerbKey(extension)) && ok;
    }
    return ok;
}

// --- Default application ----------------------------------------------------

[[nodiscard]] std::wstring ClassesKeyFor(std::wstring_view extensionOrProgId) {
    std::wstring key(kClassesKey);
    key += extensionOrProgId;
    return key;
}

// Writes the ProgID, its icon (the document icon in this executable) and its
// open command, then points the extensions at it.  HK_CURRENT_USER only, so no
// administrator prompt and nothing touched outside this user's profile.
[[nodiscard]] bool RegisterDefaultApplication() {
    const std::wstring executable = ExePath();
    if (executable.empty()) {
        return false;
    }
    const std::wstring quotedExecutable = L"\"" + executable + L"\"";
    const std::wstring progIdKey = ClassesKeyFor(kProgId);

    bool ok = true;
    ok = WriteRegistryString(HKEY_CURRENT_USER, progIdKey, nullptr, kProgIdDescription) && ok;
    ok = WriteRegistryString(HKEY_CURRENT_USER, progIdKey, L"FriendlyTypeName", kProgIdDescription) && ok;
    ok = WriteRegistryString(HKEY_CURRENT_USER, progIdKey + L"\\DefaultIcon", nullptr,
                             quotedExecutable + L",-" + std::to_wstring(IDI_DOCICON)) && ok;
    ok = WriteRegistryString(HKEY_CURRENT_USER, progIdKey + L"\\shell\\open\\command", nullptr,
                             quotedExecutable + L" \"%1\"") && ok;

    for (const wchar_t* extension : kAssociatedExtensions) {
        const std::wstring extensionKey = ClassesKeyFor(extension);
        ok = WriteRegistryString(HKEY_CURRENT_USER, extensionKey, nullptr, kProgId) && ok;
        // OpenWithProgids makes the entry show up in "Open with" lists even
        // while another application is still the default.
        ok = WriteRegistryString(HKEY_CURRENT_USER, extensionKey + L"\\OpenWithProgids", kProgId, L"") && ok;
    }
    return ok;
}

[[nodiscard]] bool UnregisterDefaultApplication() {
    bool ok = true;
    for (const wchar_t* extension : kAssociatedExtensions) {
        const std::wstring extensionKey = ClassesKeyFor(extension);
        // Only remove the default when it is ours: someone else's choice has to
        // survive being switched off here.
        std::wstring current;
        if (ReadRegistryString(HKEY_CURRENT_USER, extensionKey, nullptr, current) && current == kProgId) {
            ok = DeleteRegistryValue(HKEY_CURRENT_USER, extensionKey, nullptr) && ok;
        }
        ok = DeleteRegistryValue(HKEY_CURRENT_USER, extensionKey + L"\\OpenWithProgids", kProgId) && ok;
    }
    ok = DeleteRegistryTree(HKEY_CURRENT_USER, ClassesKeyFor(kProgId)) && ok;
    return ok;
}

// Windows remembers the application the user picked for an extension in
// FileExts\<ext>\UserChoice, and that value beats the plain default.  When it
// exists and names somebody else, this application is not really the default -
// and saying so is better than pretending the checkbox did more than it did.
[[nodiscard]] std::wstring UserChoiceProgId(std::wstring_view extension) {
    std::wstring key = L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\";
    key += extension;
    key += L"\\UserChoice";
    std::wstring progId;
    if (!ReadRegistryString(HKEY_CURRENT_USER, key, L"ProgId", progId)) {
        return std::wstring();
    }
    return progId;
}

// Turns a ProgID into something a person can read: "Applications\whatever.exe"
// becomes "whatever.exe".  Everything else is left alone, because a ProgID such
// as "JustViewMD.md" is already what Windows' own dialogs show.
[[nodiscard]] std::wstring FriendlyProgId(const std::wstring& progId) {
    const std::wstring applicationsPrefix = L"Applications\\";
    if (progId.compare(0, applicationsPrefix.size(), applicationsPrefix) == 0) {
        return progId.substr(applicationsPrefix.size());
    }
    return progId;
}

// True when this application's ProgID is the registered handler for every
// associated extension.  Windows can still insist on a UserChoice elsewhere -
// that is a separate question, and DescribeDefaultOverride() answers it.
[[nodiscard]] bool IsDefaultApplication() {
    for (const wchar_t* extension : kAssociatedExtensions) {
        std::wstring current;
        if (!ReadRegistryString(HKEY_CURRENT_USER, ClassesKeyFor(extension), nullptr, current) ||
            current != kProgId) {
            return false;
        }
    }
    return true;
}

// A sentence naming the application Windows actually uses, or an empty string
// when no UserChoice stands in the way.
[[nodiscard]] std::wstring DescribeDefaultOverride() {
    for (const wchar_t* extension : kAssociatedExtensions) {
        const std::wstring choice = UserChoiceProgId(extension);
        if (choice.empty() || choice == kProgId) {
            continue;
        }
        std::wstring text = L"Windows still opens ";
        text += extension;
        text += L" with ";
        text += FriendlyProgId(choice);
        text += L". Options \x2192 Windows default apps changes that.";
        return text;
    }
    return std::wstring();
}

// ===========================================================================
//  7. Application state
// ===========================================================================

// One open document.  The host owns the path, the line-ending style and a
// mirror of the text; the page owns the live buffer and the dirty flag, so
// switching tabs never has to wait for a round trip.
struct Tab {
    std::wstring path;      // empty while the document is untitled
    // Label shown while there is no path: "Untitled.md", "Untitled-2.md", ...
    // Kept apart from the path so saving never renames the buffer behind the
    // user's back, and so two empty tabs never look alike in the strip.
    std::wstring untitledName;
    std::wstring mirror;    // last text the page reported
    bool mirrorValid = false;
    bool dirty = false;
    bool usesCrLf = true;
};

struct App {
    HINSTANCE instance = nullptr;
    HWND window = nullptr;

    ComPtr<ICoreWebView2Environment> environment;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;
    IDropTarget* dropTarget = nullptr;  // ours to revoke and release
    // WebView2 child windows the same drop target is registered on: OLE gives a
    // drop to the window under the cursor without climbing to the parent, and the
    // WebView2 paints into children of its own.
    std::vector<HWND> webViewDropWindows;

    std::wstring assetsDirectory;      // unpacked front end, or --assets
    std::wstring userDataDirectory;    // %LOCALAPPDATA%\JustViewMD\WebView2
    std::wstring imageCacheDirectory;  // %LOCALAPPDATA%\JustViewMD\cache
    std::wstring pendingOpenPath;      // file given on the command line
    std::wstring pendingContentReason; // non-empty while the page buffers are in flight

    std::vector<Tab> tabs;             // never empty once the window is up
    int activeTab = 0;

    // Options and the session, persisted in
    // %LOCALAPPDATA%\JustViewMD\settings.ini.
    std::wstring viewMode = L"split";  // split | editor | preview
    bool darkMode = true;
    bool keepOpenedFiles = false;
    bool startBlank = false;           // no welcome document on start
    bool wrapLines = true;
    std::vector<std::wstring> sessionPaths;  // files to reopen, in tab order
    std::wstring sessionActive;              // the tab that was active
    std::string settingsFileCache;     // last text written, to skip no-op writes

    int pendingContentCount = 0;       // content messages still expected
    int pendingKeepTab = -1;           // "close other tabs": the tab that stays

    // Pictures the page asked for: everything requested until the answer is
    // sent, and the requests that wait for one of the download slots.
    std::set<std::wstring> imageDownloads;
    std::deque<std::wstring> imageQueue;
    size_t imageDownloadsRunning = 0;

    // The update check.  What the last one found is only ever shown in the
    // Options menu: the check that runs when the window opens must never
    // interrupt.  A check the user asked for reports its outcome on screen.
    bool checkForUpdate = true;        // the setting; the menu works regardless
    bool updateCheckRunning = false;
    bool updateCheckedOnStart = false; // the automatic check runs once per run
    bool updateAsked = false;          // a running check owes the user an answer
    std::wstring updateState = L"idle";  // idle|checking|uptodate|available|failed
    std::wstring updateLatest;         // the version a newer release carries
    std::wstring updateUrl;            // where to get it
    std::wstring updateMessage;        // why a check failed

    bool webReady = false;
    bool webEverLoaded = false;
    bool devToolsEnabled = false;
    bool dropOverlayVisible = false;
    double zoomFactor = 1.0;

    EventRegistrationToken messageToken{};
    EventRegistrationToken navigationToken{};
    EventRegistrationToken newWindowToken{};
    EventRegistrationToken permissionToken{};
};

App g_app;

// Directory used to seed the Open/Save dialogs.
std::wstring g_lastDirectory;

// ===========================================================================
//  7b. Options and the session
// ===========================================================================

// The settings file is deliberately plain text: it can be read, backed up and
// edited by hand, and it keeps the whole application state in one place.
[[nodiscard]] std::wstring SettingsFilePath() {
    return JoinPath(JoinPath(LocalAppDataDirectory(), kAppName), kSettingsFileName);
}

[[nodiscard]] bool EqualsIgnoringCase(std::wstring_view left, std::wstring_view right) {
    return ::CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
                                  right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

[[nodiscard]] std::wstring TrimSpaces(std::wstring_view text) {
    size_t begin = 0;
    size_t end = text.size();
    while (begin < end && (text[begin] == L' ' || text[begin] == L'\t')) {
        ++begin;
    }
    // '\r' belongs to the line ending: the text is split on '\n' alone.
    while (end > begin && (text[end - 1] == L' ' || text[end - 1] == L'\t' || text[end - 1] == L'\r')) {
        --end;
    }
    return std::wstring(text.substr(begin, end - begin));
}

[[nodiscard]] bool ParseBoolean(std::wstring_view value, bool& result) {
    if (value == L"1" || EqualsIgnoringCase(value, L"true") || EqualsIgnoringCase(value, L"yes")) {
        result = true;
        return true;
    }
    if (value == L"0" || EqualsIgnoringCase(value, L"false") || EqualsIgnoringCase(value, L"no")) {
        result = false;
        return true;
    }
    return false;
}

// The canonical contents of the file, built from the live state.  Every write
// goes through this, so saving one option never loses the others.
[[nodiscard]] std::string ComposeSettingsText() {
    std::string text;
    text += "; JustViewMD settings.\r\n";
    text += "; The application rewrites this file whenever an option changes, so edits\r\n";
    text += "; made while it is running are overwritten.\r\n";
    text += "\r\n";
    text += "viewMode=";
    text += WideToUtf8(g_app.viewMode);
    text += "\r\ndarkMode=";
    text += g_app.darkMode ? "1" : "0";
    text += "\r\nwrapLines=";
    text += g_app.wrapLines ? "1" : "0";
    text += "\r\nkeepOpenedFiles=";
    text += g_app.keepOpenedFiles ? "1" : "0";
    text += "\r\nstartBlank=";
    text += g_app.startBlank ? "1" : "0";
    text += "\r\ncheckForUpdate=";
    text += g_app.checkForUpdate ? "1" : "0";
    text += "\r\n\r\n; The files reopened on the next start, one per line, in tab\r\n";
    text += "; order.  They are only used when keepOpenedFiles=1.\r\n";
    for (const std::wstring& path : g_app.sessionPaths) {
        text += "sessionOpen=";
        text += WideToUtf8(path);
        text += "\r\n";
    }
    if (!g_app.sessionActive.empty()) {
        text += "sessionActive=";
        text += WideToUtf8(g_app.sessionActive);
        text += "\r\n";
    }
    return text;
}

// Applies the text over the current state: absent keys keep their default,
// unknown keys are ignored so a newer file still opens in this build.
void ApplySettingsText(std::wstring_view text) {
    g_app.sessionPaths.clear();
    g_app.sessionActive.clear();
    size_t position = 0;
    while (position < text.size()) {
        size_t lineEnd = text.find(L'\n', position);
        if (lineEnd == std::wstring_view::npos) {
            lineEnd = text.size();
        }
        const std::wstring line = TrimSpaces(text.substr(position, lineEnd - position));
        position = lineEnd + 1;
        if (line.empty() || line[0] == L';' || line[0] == L'#') {
            continue;
        }
        const size_t equals = line.find(L'=');
        if (equals == std::wstring::npos) {
            continue;
        }
        const std::wstring key = TrimSpaces(std::wstring_view(line).substr(0, equals));
        const std::wstring value = TrimSpaces(std::wstring_view(line).substr(equals + 1));
        bool flag = false;
        if (EqualsIgnoringCase(key, L"viewMode")) {
            if (value == L"split" || value == L"editor" || value == L"preview") {
                g_app.viewMode = value;
            }
        } else if (EqualsIgnoringCase(key, L"darkMode")) {
            if (ParseBoolean(value, flag)) {
                g_app.darkMode = flag;
            }
        } else if (EqualsIgnoringCase(key, L"wrapLines")) {
            if (ParseBoolean(value, flag)) {
                g_app.wrapLines = flag;
            }
        } else if (EqualsIgnoringCase(key, L"keepOpenedFiles")) {
            if (ParseBoolean(value, flag)) {
                g_app.keepOpenedFiles = flag;
            }
        } else if (EqualsIgnoringCase(key, L"startBlank")) {
            if (ParseBoolean(value, flag)) {
                g_app.startBlank = flag;
            }
        } else if (EqualsIgnoringCase(key, L"checkForUpdate")) {
            if (ParseBoolean(value, flag)) {
                g_app.checkForUpdate = flag;
            }
        } else if (EqualsIgnoringCase(key, L"sessionOpen")) {
            if (!value.empty()) {
                g_app.sessionPaths.push_back(value);
            }
        } else if (EqualsIgnoringCase(key, L"sessionActive")) {
            g_app.sessionActive = value;
        }
    }
}

// Reads the file if it is there.  A UTF-8 BOM (which some Windows editors add)
// and UTF-16 files are accepted so that hand edits are not lost.
[[nodiscard]] bool LoadSettingsFile() {
    std::string bytes;
    if (!ReadWholeFile(SettingsFilePath(), bytes) || bytes.empty()) {
        return false;
    }
    std::wstring text;
    if (bytes.size() >= 2 && static_cast<unsigned char>(bytes[0]) == 0xFF &&
        static_cast<unsigned char>(bytes[1]) == 0xFE) {
        const size_t length = (bytes.size() - 2) / 2;
        text.resize(length);
        for (size_t index = 0; index < length; ++index) {
            text[index] = static_cast<wchar_t>(static_cast<unsigned char>(bytes[2 + index * 2]) |
                                               (static_cast<unsigned char>(bytes[3 + index * 2]) << 8));
        }
    } else if (bytes.size() >= 2 && static_cast<unsigned char>(bytes[0]) == 0xFE &&
               static_cast<unsigned char>(bytes[1]) == 0xFF) {
        const size_t length = (bytes.size() - 2) / 2;
        text.resize(length);
        for (size_t index = 0; index < length; ++index) {
            text[index] = static_cast<wchar_t>((static_cast<unsigned char>(bytes[2 + index * 2]) << 8) |
                                               static_cast<unsigned char>(bytes[3 + index * 2]));
        }
    } else {
        const char* data = bytes.data();
        size_t size = bytes.size();
        if (size >= 3 && static_cast<unsigned char>(data[0]) == 0xEF &&
            static_cast<unsigned char>(data[1]) == 0xBB && static_cast<unsigned char>(data[2]) == 0xBF) {
            data += 3;
            size -= 3;
        }
        text = Utf8ToWide(std::string_view(data, size));
    }
    ApplySettingsText(text);
    DebugLog(L"Options loaded from " + SettingsFilePath());
    return true;
}

// Writes the file when its text changed.  The return value matters to the
// migration path, which only deletes the old registry values after a write.
[[nodiscard]] bool WriteSettingsFile() {
    const std::string text = ComposeSettingsText();
    if (text == g_app.settingsFileCache) {
        return true;
    }
    const std::wstring path = SettingsFilePath();
    if (!EnsureDirectory(DirectoryOf(path))) {
        DebugLog(L"Options: cannot create " + DirectoryOf(path));
        return false;
    }
    if (!WriteWholeFileAtomically(path, text)) {
        DebugLog(L"Options: cannot write " + path);
        return false;
    }
    g_app.settingsFileCache = text;
    return true;
}

// The values the releases before the settings file kept in
// HKCU\Software\JustViewMD.  Reading them is all that key is still used for.
[[nodiscard]] bool ReadLegacyRegistryOptions() {
    bool found = false;
    std::wstring view;
    if (ReadRegistryString(HKEY_CURRENT_USER, kLegacySettingsKey, L"ViewMode", view) &&
        (view == L"split" || view == L"editor" || view == L"preview")) {
        g_app.viewMode = view;
        found = true;
    }
    DWORD value = 0;
    if (ReadRegistryDword(HKEY_CURRENT_USER, kLegacySettingsKey, L"DarkMode", value)) {
        g_app.darkMode = value != 0;
        found = true;
    }
    if (ReadRegistryDword(HKEY_CURRENT_USER, kLegacySettingsKey, L"KeepOpenedFiles", value)) {
        g_app.keepOpenedFiles = value != 0;
        found = true;
    }
    if (ReadRegistryDword(HKEY_CURRENT_USER, kLegacySettingsKey, L"StartBlank", value)) {
        g_app.startBlank = value != 0;
        found = true;
    }
    if (ReadRegistryDword(HKEY_CURRENT_USER, kLegacySettingsKey, L"WrapLines", value)) {
        g_app.wrapLines = value != 0;
        found = true;
    }
    std::vector<std::wstring> paths;
    if (ReadRegistryMultiString(HKEY_CURRENT_USER, kLegacySessionKey, L"Open", paths) && !paths.empty()) {
        g_app.sessionPaths = paths;
        found = true;
    }
    std::wstring active;
    if (ReadRegistryString(HKEY_CURRENT_USER, kLegacySessionKey, L"Active", active) && !active.empty()) {
        g_app.sessionActive = active;
        found = true;
    }
    return found;
}

// Only the values this application wrote: the key also holds the settings of an
// older JustViewMD, and those are left alone.
void RemoveLegacyRegistryOptions() {
    (void)DeleteRegistryValue(HKEY_CURRENT_USER, kLegacySettingsKey, L"ViewMode");
    (void)DeleteRegistryValue(HKEY_CURRENT_USER, kLegacySettingsKey, L"DarkMode");
    (void)DeleteRegistryValue(HKEY_CURRENT_USER, kLegacySettingsKey, L"KeepOpenedFiles");
    (void)DeleteRegistryValue(HKEY_CURRENT_USER, kLegacySettingsKey, L"StartBlank");
    (void)DeleteRegistryValue(HKEY_CURRENT_USER, kLegacySettingsKey, L"WrapLines");
    (void)DeleteRegistryTree(HKEY_CURRENT_USER, kLegacySessionKey);
}

void LoadOptions() {
    if (LoadSettingsFile()) {
        // Remember the canonical text, so a start that changes nothing does not
        // rewrite a file that may have been edited by hand.
        g_app.settingsFileCache = ComposeSettingsText();
    } else if (ReadLegacyRegistryOptions() && WriteSettingsFile()) {
        RemoveLegacyRegistryOptions();
        DebugLog(L"Options migrated to " + SettingsFilePath());
    } else {
        // Nothing to migrate: create the file with the defaults, so it is easy
        // to find and edit.
        (void)WriteSettingsFile();
    }
    DebugLog(L"Options: view=" + g_app.viewMode +
             L" dark=" + (g_app.darkMode ? L"1" : L"0") +
             L" wrap=" + (g_app.wrapLines ? L"1" : L"0") +
             L" keep=" + (g_app.keepOpenedFiles ? L"1" : L"0") +
             L" blank=" + (g_app.startBlank ? L"1" : L"0") +
             L" session=" + std::to_wstring(g_app.sessionPaths.size()));
}

void SaveOptions() {
    (void)WriteSettingsFile();
}

// The session is the set of files that had a path: an untitled buffer has
// nothing to reopen, and reopening files is exactly what the option promises.
void SaveSession() {
    g_app.sessionPaths.clear();
    for (const Tab& tab : g_app.tabs) {
        if (!tab.path.empty()) {
            g_app.sessionPaths.push_back(tab.path);
        }
    }
    g_app.sessionActive.clear();
    if (g_app.activeTab >= 0 && g_app.activeTab < static_cast<int>(g_app.tabs.size())) {
        g_app.sessionActive = g_app.tabs[static_cast<size_t>(g_app.activeTab)].path;
    }
    (void)WriteSettingsFile();
}

// ===========================================================================
//  8. Talking to the page
// ===========================================================================

void SendToWeb(std::wstring_view json) {
    if (!g_app.webview || !g_app.webReady) {
        return;
    }
    const std::wstring message(json);
    const HRESULT result = g_app.webview->PostWebMessageAsJson(message.c_str());
    if (FAILED(result)) {
        DebugLog(L"PostWebMessageAsJson failed");
    }
}

void RunScriptInWeb(std::wstring_view script) {
    if (!g_app.webview || !g_app.webReady) {
        return;
    }
    const std::wstring code(script);
    (void)g_app.webview->ExecuteScript(code.c_str(), nullptr);
}

// --- Remote images ----------------------------------------------------------
//
// The page never loads a picture from the web itself.  It asks the host for
// every http(s) image it renders; the host downloads it once into
// %LOCALAPPDATA%\JustViewMD\cache and answers with a https://cache.local/
// address, which the WebView2 serves straight out of that folder.  A document
// therefore looks the same offline once its pictures have been seen, and
// reading one cannot tell a web server who read it, from where, or when.

// Only plain web addresses are downloaded: a data:, file: or blob: URL is
// local already, and the two virtual hosts are the viewer's own.
[[nodiscard]] bool IsRemoteImageUrl(const std::wstring& url) {
    if (url.size() < 8 || url.size() > 4096) {
        return false;
    }
    const bool plain  = ::CompareStringOrdinal(url.c_str(), 7, L"http://",  7, TRUE) == CSTR_EQUAL;
    const bool secure = ::CompareStringOrdinal(url.c_str(), 8, L"https://", 8, TRUE) == CSTR_EQUAL;
    if (!plain && !secure) {
        return false;
    }
    return url.rfind(kAssetOrigin, 0) != 0 && url.rfind(kImageCacheOrigin, 0) != 0;
}

[[nodiscard]] std::wstring Lowercased(std::wstring_view text) {
    std::wstring result(text);
    for (wchar_t& ch : result) {
        if (ch >= L'A' && ch <= L'Z') {
            ch = static_cast<wchar_t>(ch - L'A' + L'a');
        }
    }
    return result;
}

// The cached copy is named after the address it came from, so one picture is
// only ever downloaded once and the name is a valid file name whatever the URL
// happened to contain.
[[nodiscard]] std::wstring ImageCacheKey(const std::wstring& url) {
    unsigned long long hash = HashBytes(url.data(), url.size() * sizeof(wchar_t));
    std::wstring key(16, L'0');
    for (size_t index = 16; index > 0; --index) {
        key[index - 1] = L"0123456789abcdef"[hash & 0xf];
        hash >>= 4;
    }
    return key;
}

// "image/png; charset=binary" becomes "png".  A server that answers with a web
// page instead of a picture must not end up in the cache, so anything that is
// not an image type is refused here.
[[nodiscard]] std::wstring ImageExtensionFromContentType(std::wstring_view type) {
    const size_t semicolon = type.find(L';');
    if (semicolon != std::wstring_view::npos) {
        type = type.substr(0, semicolon);
    }
    const size_t slash = type.find(L'/');
    if (slash == std::wstring_view::npos || Lowercased(type.substr(0, slash)) != L"image") {
        return std::wstring();
    }
    std::wstring subtype = Lowercased(type.substr(slash + 1));
    while (!subtype.empty() && (subtype.back() == L' ' || subtype.back() == L'\t')) {
        subtype.pop_back();
    }
    if (subtype == L"jpeg") {
        return L"jpg";
    }
    if (subtype == L"svg+xml") {
        return L"svg";
    }
    if (subtype == L"vnd.microsoft.icon" || subtype == L"x-icon") {
        return L"ico";
    }
    if (subtype == L"x-ms-bmp") {
        return L"bmp";
    }
    if (subtype.rfind(L"x-", 0) == 0) {
        subtype.erase(0, 2);
    }
    std::wstring extension;
    for (const wchar_t ch : subtype) {
        if ((ch >= L'a' && ch <= L'z') || (ch >= L'0' && ch <= L'9')) {
            extension.push_back(ch);
        }
    }
    return extension.size() >= 2 && extension.size() <= 5 ? extension : std::wstring();
}

// What the bytes themselves say.  This is the most reliable of the three
// answers, and the one that tells a picture apart from an error page.
[[nodiscard]] const wchar_t* ImageExtensionFromBytes(const std::vector<unsigned char>& bytes) {
    const unsigned char* data = bytes.data();
    const size_t size = bytes.size();
    if (size >= 8 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47) {
        return L"png";
    }
    if (size >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) {
        return L"jpg";
    }
    if (size >= 4 && std::memcmp(data, "GIF8", 4) == 0) {
        return L"gif";
    }
    if (size >= 2 && data[0] == 'B' && data[1] == 'M') {
        return L"bmp";
    }
    if (size >= 12 && std::memcmp(data, "RIFF", 4) == 0 && std::memcmp(data + 8, "WEBP", 4) == 0) {
        return L"webp";
    }
    if (size >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 1 && data[3] == 0) {
        return L"ico";
    }
    if (size >= 12 && std::memcmp(data + 4, "ftyp", 4) == 0) {
        if (std::memcmp(data + 8, "avif", 4) == 0 || std::memcmp(data + 8, "avis", 4) == 0) {
            return L"avif";
        }
        if (std::memcmp(data + 8, "heic", 4) == 0 || std::memcmp(data + 8, "heix", 4) == 0) {
            return L"heic";
        }
    }
    if (size >= 4 && ((data[0] == 'I' && data[1] == 'I' && data[2] == 0x2A && data[3] == 0) ||
                      (data[0] == 'M' && data[1] == 'M' && data[2] == 0 && data[3] == 0x2A))) {
        return L"tiff";
    }
    // SVG is text, so it is recognised from the markup at the very start; a web
    // page that merely mentions <svg> further down is not a picture.
    size_t start = 0;
    if (size >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF) {
        start = 3;  // UTF-8 byte order mark
    }
    const size_t head = size < 1024 ? size : 1024;
    while (start < head && (data[start] == ' ' || data[start] == '\t' || data[start] == '\r' ||
                            data[start] == '\n')) {
        ++start;
    }
    if (start + 4 <= head) {
        std::string lead(reinterpret_cast<const char*>(data + start), 4);
        for (char& ch : lead) {
            if (ch >= 'A' && ch <= 'Z') {
                ch = static_cast<char>(ch - 'A' + 'a');
            }
        }
        if (lead.rfind("<svg", 0) == 0) {
            return L"svg";
        }
        if (lead.rfind("<?xm", 0) == 0 || lead.rfind("<!--", 0) == 0 || lead.rfind("<!do", 0) == 0) {
            std::string probe(reinterpret_cast<const char*>(data + start), head - start);
            for (char& ch : probe) {
                if (ch >= 'A' && ch <= 'Z') {
                    ch = static_cast<char>(ch - 'A' + 'a');
                }
            }
            if (probe.find("<svg") != std::string::npos) {
                return L"svg";
            }
        }
    }
    return nullptr;
}

// A last resort for servers that send no useful type: many addresses end in the
// extension of the file they point at.
[[nodiscard]] std::wstring ImageExtensionFromUrl(const std::wstring& url) {
    const size_t separator = url.find_first_of(L"?#");
    const std::wstring address = separator == std::wstring::npos ? url : url.substr(0, separator);
    const size_t slash = address.find_last_of(L'/');
    const size_t dot = address.find_last_of(L'.');
    if (dot == std::wstring::npos || (slash != std::wstring::npos && dot < slash) ||
        dot + 1 >= address.size()) {
        return std::wstring();
    }
    std::wstring extension = Lowercased(std::wstring_view(address).substr(dot + 1));
    if (extension == L"jpeg") {
        extension = L"jpg";
    }
    static const wchar_t* const kKnown[] = {L"png", L"jpg",  L"gif",  L"webp", L"svg",
                                            L"bmp", L"ico",  L"avif", L"apng", L"tif",
                                            L"tiff", L"heic", L"jxl"};
    for (const wchar_t* candidate : kKnown) {
        if (extension == candidate) {
            return extension;
        }
    }
    return std::wstring();
}

// Small owner for the WinHTTP handles, so every early return above closes them.
struct WinHttpHandle {
    explicit WinHttpHandle(HINTERNET value) noexcept : m_handle(value) {}
    ~WinHttpHandle() {
        if (m_handle != nullptr) {
            ::WinHttpCloseHandle(m_handle);
        }
    }
    WinHttpHandle(const WinHttpHandle&) = delete;
    WinHttpHandle& operator=(const WinHttpHandle&) = delete;
    [[nodiscard]] HINTERNET get() const noexcept { return m_handle; }
    [[nodiscard]] bool valid() const noexcept { return m_handle != nullptr; }

private:
    HINTERNET m_handle = nullptr;
};

// One GET of an address, with the answer handed back as bytes.  Both the
// pictures a document points at and the update check are fetched with it.
// Runs on a download thread, so it only touches its own arguments.
[[nodiscard]] bool DownloadBytes(const std::wstring& url, std::vector<unsigned char>& bytes,
                                 std::wstring& contentType, std::wstring& reason) {
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (::WinHttpCrackUrl(url.c_str(), 0, 0, &parts) == FALSE || parts.dwHostNameLength == 0) {
        reason = L"the address could not be read";
        return false;
    }
    const bool secure = ::CompareStringOrdinal(url.c_str(), 8, L"https://", 8, TRUE) == CSTR_EQUAL;
    const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength > 0) {
        path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    }
    if (path.empty()) {
        path = L"/";
    }

    WinHttpHandle session(::WinHttpOpen(L"JustViewMD (Markdown preview)",
                                        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
                                        WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.valid()) {
        reason = L"the internet library could not be started";
        return false;
    }
    // Resolve, connect, send, receive - all in milliseconds.
    (void)::WinHttpSetTimeouts(session.get(), 15000, 15000, 30000, 60000);
    WinHttpHandle connection(::WinHttpConnect(session.get(), host.c_str(), parts.nPort, 0));
    if (!connection.valid()) {
        reason = L"the server could not be reached";
        return false;
    }
    WinHttpHandle request(::WinHttpOpenRequest(connection.get(), L"GET", path.c_str(), nullptr,
                                               WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                               secure ? WINHTTP_FLAG_SECURE : 0));
    if (!request.valid()) {
        reason = L"the request could not be prepared";
        return false;
    }
    // Following a redirect is normal: an image host usually hands the file to a
    // content network.
    DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    (void)::WinHttpSetOption(request.get(), WINHTTP_OPTION_REDIRECT_POLICY, &redirects,
                             sizeof(redirects));
    if (::WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA,
                             0, 0, 0) == FALSE ||
        ::WinHttpReceiveResponse(request.get(), nullptr) == FALSE) {
        reason = L"the server did not answer";
        return false;
    }
    DWORD status = 0;
    DWORD size = sizeof(status);
    if (::WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                              WINHTTP_HEADER_NAME_BY_INDEX, &status, &size,
                              WINHTTP_NO_HEADER_INDEX) != FALSE && (status < 200 || status > 299)) {
        reason = L"the server answered " + std::to_wstring(status);
        return false;
    }
    DWORD declared = 0;
    size = sizeof(declared);
    if (::WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
                              WINHTTP_HEADER_NAME_BY_INDEX, &declared, &size,
                              WINHTTP_NO_HEADER_INDEX) != FALSE && declared > kMaxImageBytes) {
        reason = L"the answer is larger than 32 MB";
        return false;
    }
    wchar_t type[128] = {};
    size = sizeof(type);
    if (::WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
                              type, &size, WINHTTP_NO_HEADER_INDEX) != FALSE) {
        contentType.assign(type);
    }
    for (;;) {
        DWORD available = 0;
        if (::WinHttpQueryDataAvailable(request.get(), &available) == FALSE) {
            reason = L"the connection was lost";
            return false;
        }
        if (available == 0) {
            break;
        }
        if (bytes.size() + available > kMaxImageBytes) {
            reason = L"the answer is larger than 32 MB";
            return false;
        }
        const size_t offset = bytes.size();
        bytes.resize(offset + available);
        DWORD read = 0;
        if (::WinHttpReadData(request.get(), bytes.data() + offset, available, &read) == FALSE) {
            reason = L"the connection was lost";
            return false;
        }
        bytes.resize(offset + read);
    }
    if (bytes.empty()) {
        reason = L"the answer was empty";
        return false;
    }
    return true;
}

// The one address whose answer is text rather than a picture: the releases API
// speaks JSON.  There is no second network stack behind it - the same download
// path is used, and only the encoding is dealt with here.
[[nodiscard]] bool FetchText(const std::wstring& url, std::wstring& text, std::wstring& reason) {
    std::vector<unsigned char> bytes;
    std::wstring contentType;
    if (!DownloadBytes(url, bytes, contentType, reason)) {
        return false;
    }
    if (bytes.size() > kMaxReleaseBytes) {
        reason = L"the answer was longer than expected";
        return false;
    }
    text = Utf8ToWide(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
    return true;
}

// Writes the picture into the cache as <key>.<extension>.  Anything that does
// not look like a picture is refused, so a login page or an error document is
// never served to the page as an image.
[[nodiscard]] bool StoreImageBytes(const std::wstring& key, const std::wstring& url,
                                   const std::wstring& contentType,
                                   const std::vector<unsigned char>& bytes, std::wstring& fileName,
                                   std::wstring& reason) {
    const wchar_t* sniffed = ImageExtensionFromBytes(bytes);
    std::wstring extension;
    if (sniffed != nullptr) {
        extension = sniffed;
    } else if (!contentType.empty()) {
        extension = ImageExtensionFromContentType(contentType);
    }
    if (extension.empty()) {
        extension = ImageExtensionFromUrl(url);
    }
    if (extension.empty()) {
        reason = L"the answer was not a picture";
        return false;
    }
    fileName = key + L"." + extension;
    // Written under a scratch name and moved into place, so a file in the cache
    // is always complete, even if the window is closed in the middle of a
    // download.
    const std::wstring partPath = JoinPath(g_app.imageCacheDirectory, L"part-" + key + L".tmp");
    if (!WriteFileDirect(partPath, bytes.data(), bytes.size())) {
        reason = L"the picture could not be written to the cache";
        return false;
    }
    const std::wstring finalPath = JoinPath(g_app.imageCacheDirectory, fileName);
    if (::MoveFileExW(partPath.c_str(), finalPath.c_str(), MOVEFILE_REPLACE_EXISTING) == FALSE) {
        reason = L"the picture could not be moved into the cache";
        return false;
    }
    return true;
}

// A picture is stored as <key>.<extension>; which extension it ended up with is
// only known once the answer has arrived, so the lookup is by key.
[[nodiscard]] bool FindCachedImage(const std::wstring& key, std::wstring& path) {
    WIN32_FIND_DATAW entry{};
    const std::wstring pattern = JoinPath(g_app.imageCacheDirectory, key + L".*");
    const HANDLE search = ::FindFirstFileW(pattern.c_str(), &entry);
    if (search == INVALID_HANDLE_VALUE) {
        return false;
    }
    bool found = false;
    do {
        const bool file = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
        const bool empty = entry.nFileSizeHigh == 0 && entry.nFileSizeLow == 0;
        if (file && !empty) {
            path = JoinPath(g_app.imageCacheDirectory, entry.cFileName);
            found = true;
            break;
        }
    } while (::FindNextFileW(search, &entry) != FALSE);
    ::FindClose(search);
    return found;
}

void SendImageReady(std::wstring_view url, std::wstring_view fileName) {
    std::wstring message = L"{\"type\":\"imageReady\",\"url\":\"";
    message += JsonEscape(url);
    message += L"\",\"src\":\"";
    message += JsonEscape(std::wstring(kImageCacheOrigin) + L"/" + std::wstring(fileName));
    message += L"\"}";
    SendToWeb(message);
}

void SendImageFailed(std::wstring_view url, std::wstring_view reason) {
    std::wstring message = L"{\"type\":\"imageFailed\",\"url\":\"";
    message += JsonEscape(url);
    message += L"\",\"message\":\"";
    message += JsonEscape(reason);
    message += L"\"}";
    SendToWeb(message);
}

struct ImageDownloadResult {
    std::wstring url;
    std::wstring fileName;  // the cached name, when the download succeeded
    std::wstring reason;    // why it did not
    bool ok = false;
};

void ImageDownloadThread(std::wstring url) {
    auto* result = new ImageDownloadResult();
    result->url = url;
    std::vector<unsigned char> bytes;
    std::wstring contentType;
    std::wstring reason;
    if (!DownloadBytes(url, bytes, contentType, reason)) {
        result->reason = reason;
    } else if (!StoreImageBytes(ImageCacheKey(url), url, contentType, bytes, result->fileName, reason)) {
        result->reason = reason;
    } else {
        result->ok = true;
    }
    // Back to the window thread: the WebView2 may only be talked to from the
    // thread that owns it.
    if (::PostMessageW(g_app.window, kImageDownloadedMessage, 0,
                       reinterpret_cast<LPARAM>(result)) == FALSE) {
        delete result;
    }
}

// The window procedure's half of the above, on the window thread: answer the
// page and start the next queued picture, so the number of threads stays inside
// kMaxImageDownloads.
void ImageDownloadFinished(const ImageDownloadResult& result) {
    g_app.imageDownloads.erase(result.url);
    if (result.ok) {
        DebugLog(L"Image downloaded: " + result.url);
        SendImageReady(result.url, result.fileName);
    } else {
        DebugLog(L"Image download failed: " + result.url + L" (" + result.reason + L")");
        SendImageFailed(result.url, result.reason);
    }
    if (g_app.imageDownloadsRunning > 0) {
        --g_app.imageDownloadsRunning;
    }
    while (!g_app.imageQueue.empty() && g_app.imageDownloadsRunning < kMaxImageDownloads) {
        const std::wstring next = g_app.imageQueue.front();
        g_app.imageQueue.pop_front();
        ++g_app.imageDownloadsRunning;
        std::thread(ImageDownloadThread, next).detach();
    }
}

void RequestImage(const std::wstring& url) {
    if (!IsRemoteImageUrl(url)) {
        SendImageFailed(url, L"not an address this viewer downloads");
        return;
    }
    if (g_app.imageCacheDirectory.empty()) {
        SendImageFailed(url, L"the image cache folder is not available");
        return;
    }
    const std::wstring key = ImageCacheKey(url);
    std::wstring cached;
    if (FindCachedImage(key, cached)) {
        DebugLog(L"Image from cache: " + url);
        SendImageReady(url, FileNameOf(cached));
        return;
    }
    if (!g_app.imageDownloads.insert(url).second) {
        return;  // already on its way; that answer covers every request
    }
    if (g_app.imageDownloadsRunning >= kMaxImageDownloads) {
        g_app.imageQueue.push_back(url);
        return;
    }
    ++g_app.imageDownloadsRunning;
    std::thread(ImageDownloadThread, url).detach();
}

// The Options menu reports what the cache holds and opens the folder for
// inspection; that is the whole of the cache's housekeeping.  Nothing in this
// program ever deletes a cached picture: what stays and what goes is decided by
// hand in Explorer.
struct ImageCacheSize {
    unsigned long long files = 0;
    unsigned long long bytes = 0;
};

[[nodiscard]] ImageCacheSize MeasureImageCache() {
    ImageCacheSize size;
    if (g_app.imageCacheDirectory.empty()) {
        return size;
    }
    WIN32_FIND_DATAW entry{};
    const std::wstring pattern = JoinPath(g_app.imageCacheDirectory, L"*");
    const HANDLE search = ::FindFirstFileW(pattern.c_str(), &entry);
    if (search == INVALID_HANDLE_VALUE) {
        return size;  // an empty folder looks the same as no folder here
    }
    do {
        if ((entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            continue;
        }
        ++size.files;
        size.bytes += (static_cast<unsigned long long>(entry.nFileSizeHigh) << 32) | entry.nFileSizeLow;
    } while (::FindNextFileW(search, &entry) != FALSE);
    ::FindClose(search);
    return size;
}

void SendImageCacheSize() {
    const ImageCacheSize size = MeasureImageCache();
    std::wstring message = L"{\"type\":\"cacheSize\",\"files\":";
    message += std::to_wstring(size.files);
    message += L",\"bytes\":";
    message += std::to_wstring(size.bytes);
    message += L"}";
    DebugLog(L"Image cache: " + std::to_wstring(size.files) + L" file(s), " +
             std::to_wstring(size.bytes) + L" bytes");
    SendToWeb(message);
}

void OpenImageCacheFolder() {
    if (g_app.imageCacheDirectory.empty()) {
        return;
    }
    (void)EnsureDirectory(g_app.imageCacheDirectory);
    const HINSTANCE opened = ::ShellExecuteW(g_app.window, L"open", g_app.imageCacheDirectory.c_str(),
                                             nullptr, nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(opened) <= 32) {
        DebugLog(L"ShellExecuteW could not open the image cache folder");
    }
}

// --- The update check ---------------------------------------------------------
//
// The releases published on GitHub are the only place a newer version can come
// from, so that is what the check reads.  It is a single GET of the public
// releases API and sends nothing but the request itself: no account, no
// identifier, and not even the version in use.  It runs in the background when
// the window opens and never interrupts - what it found is remembered and shown
// in the Options menu.  Only a check the user asked for reports itself on
// screen, and even that is a toast rather than a dialog.

// "v1.2.3" as a number, so two versions can be compared.  A missing part counts
// as zero, so "1.2" and "1.2.0" are the same version, and a fourth number - a
// build number - is ignored: releases are named with three.
[[nodiscard]] unsigned long long VersionNumber(std::wstring_view text) {
    unsigned long long value = 0;
    int seen = 0;
    size_t index = 0;
    while (index < text.size() && seen < 3) {
        if (text[index] < L'0' || text[index] > L'9') {
            ++index;
            continue;  // the "v", the dots and anything else between numbers
        }
        unsigned long long part = 0;
        while (index < text.size() && text[index] >= L'0' && text[index] <= L'9') {
            part = std::min<unsigned long long>(part * 10 + static_cast<unsigned long long>(text[index] - L'0'),
                                                999);
            ++index;
        }
        value = value * 1000 + part;
        ++seen;
    }
    while (seen < 3) {
        value *= 1000;
        ++seen;
    }
    return value;
}

// A release is tagged "v1.2.3"; the version is what follows the v.  A tag that
// holds no number at all is not a version and is reported as a failure rather
// than silently passing for the newest release.
[[nodiscard]] std::wstring VersionFromTag(std::wstring_view tag) {
    std::wstring text = TrimSpaces(tag);
    if (!text.empty() && (text[0] == L'v' || text[0] == L'V')) {
        text.erase(0, 1);
    }
    if (text.find_first_of(L"0123456789") == std::wstring::npos) {
        return std::wstring();
    }
    return text;
}

struct UpdateCheckResult {
    std::wstring state;   // uptodate | available | failed
    std::wstring latest;  // the version the answer carried
    std::wstring url;     // where to get it
    std::wstring reason;  // why a check failed
    bool asked = false;   // the user is waiting for this one
};

// Runs on its own thread, like a picture download: the window never waits for
// the network.  It touches nothing but the constants and g_app.window.
void UpdateCheckThread(bool asked) {
    auto* result = new UpdateCheckResult();
    result->asked = asked;
    result->url = kReleasesPageUrl;
    std::wstring text;
    std::wstring reason;
    if (!FetchText(kReleasesApiUrl, text, reason)) {
        result->state = L"failed";
        // Before the first release is published there is nothing to compare
        // with, and saying so beats passing the raw status code on.
        result->reason = (reason == L"the server answered 404")
                             ? std::wstring(L"no release has been published yet")
                             : reason;
    } else {
        const JsonReader reader(text);
        const std::wstring tag = reader.GetString(L"tag_name");
        const std::wstring page = reader.GetString(L"html_url");
        const std::wstring latest = VersionFromTag(tag);
        if (!page.empty()) {
            result->url = page;
        }
        if (tag.empty()) {
            result->state = L"failed";
            result->reason = L"the answer did not name a release";
        } else if (latest.empty()) {
            result->state = L"failed";
            result->reason = L"the release is not named like a version (" + tag + L")";
        } else {
            result->latest = latest;
            result->state =
                VersionNumber(latest) > VersionNumber(kAppVersion) ? L"available" : L"uptodate";
        }
    }
    // Back to the window thread: the WebView2 may only be talked to from the
    // thread that owns it.
    if (::PostMessageW(g_app.window, kUpdateCheckedMessage, 0, reinterpret_cast<LPARAM>(result)) == FALSE) {
        delete result;
    }
}

// Tells the page where the check stands.  `asked` is what the page uses to
// decide whether to say anything: the start-up check is deliberately silent.
void SendUpdateState(bool asked) {
    std::wstring message = L"{\"type\":\"update\",\"state\":\"";
    message += g_app.updateState;
    message += L"\",\"current\":\"";
    message += JsonEscape(kAppVersion);
    message += L"\",\"latest\":\"";
    message += JsonEscape(g_app.updateLatest);
    message += L"\",\"url\":\"";
    message += JsonEscape(g_app.updateUrl.empty() ? std::wstring_view(kReleasesPageUrl)
                                                 : std::wstring_view(g_app.updateUrl));
    message += L"\",\"message\":\"";
    message += JsonEscape(g_app.updateMessage);
    message += L"\",\"asked\":";
    message += asked ? L"true" : L"false";
    message += L"}";
    SendToWeb(message);
}

// The window procedure's half of the above.
void UpdateCheckFinished(const UpdateCheckResult& result) {
    g_app.updateCheckRunning = false;
    g_app.updateState = result.state;
    g_app.updateLatest = result.latest;
    g_app.updateMessage = result.reason;
    if (!result.url.empty()) {
        g_app.updateUrl = result.url;
    }
    // A check that was asked for while this one ran is answered by it.
    const bool asked = result.asked || g_app.updateAsked;
    g_app.updateAsked = false;
    if (result.state == L"available") {
        DebugLog(L"Update check: " + std::wstring(kAppVersion) + L" -> " + result.latest +
                 L" is available");
    } else if (result.state == L"failed") {
        DebugLog(L"Update check failed: " + result.reason);
    } else {
        DebugLog(L"Update check: " + std::wstring(kAppVersion) + L" is the latest release");
    }
    SendUpdateState(asked);
}

void RequestUpdateCheck(bool asked) {
    if (g_app.updateCheckRunning) {
        // One check at a time.  The one in flight can answer the user instead of
        // asking GitHub twice; if it answers before the question arrives, the
        // question has still been recorded and is answered below.
        g_app.updateAsked = g_app.updateAsked || asked;
        return;
    }
    g_app.updateCheckRunning = true;
    g_app.updateAsked = asked;
    g_app.updateState = L"checking";
    g_app.updateMessage.clear();
    if (asked) {
        DebugLog(L"Update check: asked for from the menu");
    } else {
        DebugLog(L"Update check: starting in the background");
    }
    SendUpdateState(asked);
    std::thread(UpdateCheckThread, asked).detach();
}

// Where "Get JustViewMD x.y.z" leads: the release page on GitHub, opened in the
// reader's own browser.  Nothing is downloaded or run by this program.
void OpenReleasePage() {
    const std::wstring url = g_app.updateUrl.empty() ? std::wstring(kReleasesPageUrl)
                                                     : g_app.updateUrl;
    const HINSTANCE opened = ::ShellExecuteW(g_app.window, L"open", url.c_str(), nullptr, nullptr,
                                             SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(opened) <= 32) {
        DebugLog(L"ShellExecuteW could not open " + url);
    }
}

// --- Tabs -------------------------------------------------------------------

[[nodiscard]] Tab* ActiveTab() {
    if (g_app.activeTab < 0 || g_app.activeTab >= static_cast<int>(g_app.tabs.size())) {
        return nullptr;
    }
    return &g_app.tabs[static_cast<size_t>(g_app.activeTab)];
}

[[nodiscard]] std::wstring TabNameOf(const Tab& tab) {
    if (!tab.path.empty()) {
        return FileNameOf(tab.path);
    }
    return tab.untitledName.empty() ? std::wstring(kUntitledName) : tab.untitledName;
}

// "Untitled.md" for the first empty buffer, then "Untitled-2.md",
// "Untitled-3.md", ...  A number is reused once its tab is gone, and names of
// open files are skipped too so no two tabs ever read the same.
[[nodiscard]] std::wstring NextUntitledName() {
    for (int suffix = 1;; ++suffix) {
        std::wstring candidate =
            suffix == 1 ? std::wstring(kUntitledName)
                        : L"Untitled-" + std::to_wstring(suffix) + L".md";
        bool taken = false;
        for (const Tab& tab : g_app.tabs) {
            const std::wstring name = TabNameOf(tab);
            if (::CompareStringOrdinal(name.c_str(), static_cast<int>(name.size()),
                                       candidate.c_str(), static_cast<int>(candidate.size()),
                                       TRUE) == CSTR_EQUAL) {
                taken = true;
                break;
            }
        }
        if (!taken) {
            return candidate;
        }
    }
}

[[nodiscard]] Tab MakeUntitledTab() {
    Tab tab;
    tab.untitledName = NextUntitledName();
    return tab;
}

// Windows paths are case insensitive, so two spellings of the same file have to
// end up in the same tab.
[[nodiscard]] int TabIndexOfPath(const std::wstring& path) {
    if (path.empty()) {
        return -1;
    }
    for (size_t index = 0; index < g_app.tabs.size(); ++index) {
        const std::wstring& candidate = g_app.tabs[index].path;
        if (candidate.empty()) {
            continue;
        }
        if (::CompareStringOrdinal(candidate.c_str(), static_cast<int>(candidate.size()), path.c_str(),
                                   static_cast<int>(path.size()), TRUE) == CSTR_EQUAL) {
            return static_cast<int>(index);
        }
    }
    return -1;
}

void UpdateWindowTitle() {
    const Tab* tab = ActiveTab();
    std::wstring title = tab != nullptr ? TabNameOf(*tab) : std::wstring(kUntitledName);
    if (tab != nullptr && tab->dirty) {
        title += L"*";
    }
    title += L" - ";
    title += kAppName;
    ::SetWindowTextW(g_app.window, title.c_str());
}

// Names, paths and which tab is active: everything the strip shows.  The text
// of the documents never travels with this message.
void SendTabList() {
    std::wstring message = L"{\"type\":\"tabs\",\"active\":";
    message += std::to_wstring(g_app.activeTab);
    message += L",\"items\":[";
    for (size_t index = 0; index < g_app.tabs.size(); ++index) {
        const Tab& tab = g_app.tabs[index];
        if (index != 0) {
            message += L",";
        }
        message += L"{\"path\":\"";
        message += JsonEscape(tab.path);
        message += L"\",\"name\":\"";
        message += JsonEscape(TabNameOf(tab));
        message += L"\"}";
    }
    message += L"]}";
    SendToWeb(message);
}

// Hands the text of one tab to the page.  "active" is the tab the page should
// show afterwards, which is usually the one whose text this is.
void SendDocumentToWeb(int index, int activate, const std::wstring& content, bool dirty) {
    if (index < 0 || index >= static_cast<int>(g_app.tabs.size())) {
        return;
    }
    const Tab& tab = g_app.tabs[static_cast<size_t>(index)];
    std::wstring message = L"{\"type\":\"document\",\"index\":";
    message += std::to_wstring(index);
    message += L",\"active\":";
    message += std::to_wstring(activate);
    message += L",\"dirty\":";
    message += dirty ? L"true" : L"false";
    message += L",\"path\":\"";
    message += JsonEscape(tab.path);
    message += L"\",\"name\":\"";
    message += JsonEscape(TabNameOf(tab));
    message += L"\",\"content\":\"";
    message += JsonEscape(content);
    message += L"\"}";
    SendToWeb(message);
}

void SendDocumentToWeb(int index, const std::wstring& content, bool dirty) {
    SendDocumentToWeb(index, index, content, dirty);
}

void SendOptionsToWeb() {
    std::wstring message = L"{\"type\":\"settings\",\"view\":\"";
    message += g_app.viewMode;
    message += L"\",\"dark\":";
    message += g_app.darkMode ? L"true" : L"false";
    message += L",\"keepOpened\":";
    message += g_app.keepOpenedFiles ? L"true" : L"false";
    message += L",\"startBlank\":";
    message += g_app.startBlank ? L"true" : L"false";
    message += L",\"wrap\":";
    message += g_app.wrapLines ? L"true" : L"false";
    message += L",\"defaultApp\":";
    message += IsDefaultApplication() ? L"true" : L"false";
    message += L"}";
    SendToWeb(message);
}

// Makes a tab the one on screen.  The page is told through the tab list (the
// text is already there) and the session remembers where the user stopped.
void RememberDirectoryOf(const std::wstring& path);

void ActivateTab(int index) {
    if (index < 0 || index >= static_cast<int>(g_app.tabs.size()) || index == g_app.activeTab) {
        return;
    }
    g_app.activeTab = index;
    UpdateWindowTitle();
    SendTabList();
    SaveSession();
    // Windows that are behind the active tab do not need a repaint.
    if (g_app.activeTab >= 0 && g_app.activeTab < static_cast<int>(g_app.tabs.size())) {
        const std::wstring path = g_app.tabs[static_cast<size_t>(g_app.activeTab)].path;
        if (!path.empty()) {
            RememberDirectoryOf(path);
        }
    }
}

void ApplyZoom(double factor) {
    if (factor < kMinZoomFactor) {
        factor = kMinZoomFactor;
    }
    if (factor > kMaxZoomFactor) {
        factor = kMaxZoomFactor;
    }
    g_app.zoomFactor = factor;
    if (g_app.controller) {
        (void)g_app.controller->put_ZoomFactor(factor);
    }
    std::wstring message = L"{\"type\":\"zoom\",\"value\":";
    message += std::to_wstring(factor);
    message += L"}";
    SendToWeb(message);
}

// ===========================================================================
//  9. Documents: open, save, reload
// ===========================================================================

void RememberDirectoryOf(const std::wstring& path) {
    const std::wstring directory = DirectoryOf(path);
    if (!directory.empty() && DirectoryExists(directory)) {
        g_lastDirectory = directory;
    }
}

[[nodiscard]] std::wstring DescribeReadFailure(const std::wstring& path, ReadStatus status) {
    std::wstring message = L"JustViewMD could not open:\n\n";
    message += path;
    message += L"\n\n";
    switch (status) {
    case ReadStatus::NotFound:
        message += L"The file no longer exists.";
        break;
    case ReadStatus::TooLarge:
        message += L"The file is larger than 64 MB.";
        break;
    case ReadStatus::NotText:
        message += L"The file does not look like a text file.";
        break;
    case ReadStatus::Failed:
    case ReadStatus::Ok:
    default:
        message += L"Reading the file failed.";
        break;
    }
    return message;
}

// Opens a file in its own tab.  A file that is already open is focused instead
// of opened twice, and a lone untouched untitled tab is reused so that the
// window does not fill up with empty tabs.
[[nodiscard]] bool OpenPathInTab(const std::wstring& path, bool showErrors) {
    if (path.empty()) {
        return false;
    }
    const int existing = TabIndexOfPath(path);
    if (existing >= 0) {
        ActivateTab(existing);
        return true;
    }

    Document document;
    const ReadStatus status = ReadDocumentFile(path, document);
    if (status != ReadStatus::Ok) {
        if (showErrors) {
            ShowErrorBox(g_app.window, DescribeReadFailure(path, status));
        }
        return false;
    }

    int index = -1;
    Tab* active = ActiveTab();
    if (active != nullptr && active->path.empty() && !active->dirty && g_app.tabs.size() == 1) {
        index = g_app.activeTab;
        *active = Tab{};
    } else {
        g_app.tabs.push_back(Tab{});
        index = static_cast<int>(g_app.tabs.size()) - 1;
    }

    Tab& tab = g_app.tabs[static_cast<size_t>(index)];
    tab.path = path;
    tab.mirror = document.text;
    tab.mirrorValid = true;
    tab.dirty = false;
    tab.usesCrLf = document.usesCrLf;

    g_app.activeTab = index;
    RememberDirectoryOf(path);
    UpdateWindowTitle();
    SendTabList();
    SendDocumentToWeb(index, document.text, false);
    SaveSession();
    DebugLog(L"Opened a file in a tab");
    return true;
}

// First run: show assets/welcome.md so the window is never empty and the user
// immediately sees what the renderer can do.  It stays an untitled document.
void LoadWelcomeTab() {
    const std::wstring welcomePath = JoinPath(g_app.assetsDirectory, kWelcomeFile);
    std::wstring content;
    Document document;
    if (ReadDocumentFile(welcomePath, document) == ReadStatus::Ok) {
        content = document.text;
    } else {
        content = kFallbackWelcome;
    }
    g_app.tabs.clear();
    g_app.tabs.push_back(MakeUntitledTab());
    g_app.activeTab = 0;
    Tab& tab = g_app.tabs[0];
    tab.mirror = content;
    tab.mirrorValid = true;
    UpdateWindowTitle();
    SendTabList();
    SendDocumentToWeb(0, content, false);
    DebugLog(L"Loaded the welcome document");
}

// The "Start with Blank" option: the same fresh window as the welcome document,
// with nothing in the buffer.
void LoadBlankTab() {
    g_app.tabs.clear();
    g_app.tabs.push_back(MakeUntitledTab());
    g_app.activeTab = 0;
    UpdateWindowTitle();
    SendTabList();
    SendDocumentToWeb(0, std::wstring(), false);
    DebugLog(L"Started with a blank document");
}

// A new empty tab, next to the ones already open.
void NewTabFlow() {
    g_app.tabs.push_back(MakeUntitledTab());
    g_app.activeTab = static_cast<int>(g_app.tabs.size()) - 1;
    UpdateWindowTitle();
    SendTabList();
    SendDocumentToWeb(g_app.activeTab, std::wstring(), false);
    SaveSession();
}

// Asks the page for the text of every tab.  The answers arrive as
// {"type":"content","index":N,...} messages, one per tab.
void RequestAllContents(std::wstring_view reason) {
    g_app.pendingContentReason.assign(reason);
    g_app.pendingContentCount = static_cast<int>(g_app.tabs.size());
    std::wstring message = L"{\"type\":\"requestContent\",\"reason\":\"";
    message += JsonEscape(reason);
    message += L"\"}";
    SendToWeb(message);
}

// Re-reads the active file from disk, discarding unsaved changes after asking.
void ReloadActiveTab() {
    Tab* tab = ActiveTab();
    if (tab == nullptr || tab->path.empty()) {
        return;
    }
    if (tab->dirty) {
        std::wstring question = L"Discard unsaved changes to ";
        question += TabNameOf(*tab);
        question += L"?";
        if (::MessageBoxW(g_app.window, question.c_str(), kAppName,
                          MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) != IDYES) {
            return;
        }
    }
    const int index = g_app.activeTab;
    Document document;
    const ReadStatus status = ReadDocumentFile(tab->path, document);
    if (status != ReadStatus::Ok) {
        ShowErrorBox(g_app.window, DescribeReadFailure(tab->path, status));
        return;
    }
    tab = &g_app.tabs[static_cast<size_t>(index)];
    tab->mirror = document.text;
    tab->mirrorValid = true;
    tab->dirty = false;
    tab->usesCrLf = document.usesCrLf;
    UpdateWindowTitle();
    SendDocumentToWeb(index, document.text, false);
    SaveSession();
}

[[nodiscard]] bool ShowSaveAsDialog(std::wstring& path, const std::wstring& untitledName) {
    wchar_t buffer[32768] = {};
    const std::wstring seed = path.empty() ? untitledName : FileNameOf(path);
    (void)::wcsncpy_s(buffer, ARRAYSIZE(buffer), seed.c_str(), _TRUNCATE);

    OPENFILENAMEW dialog{};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = g_app.window;
    dialog.lpstrFilter = L"Markdown (*.md)\0*.md\0"
                         L"Markdown (*.markdown)\0*.markdown\0"
                         L"Text (*.txt)\0*.txt\0"
                         L"All files (*.*)\0*.*\0\0";
    dialog.lpstrFile = buffer;
    dialog.nMaxFile = ARRAYSIZE(buffer);
    dialog.lpstrDefExt = L"md";
    dialog.lpstrTitle = L"Save Markdown file as";
    dialog.lpstrInitialDir = g_lastDirectory.empty() ? nullptr : g_lastDirectory.c_str();
    dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_EXPLORER | OFN_DONTADDTORECENT |
                   OFN_NOCHANGEDIR;

    if (!::GetSaveFileNameW(&dialog)) {
        return false;
    }
    path.assign(buffer);
    return true;
}

// Writes the text of one tab to disk, asking for a file name when needed.  The
// text comes from the page, so what lands on disk is what the user sees.
[[nodiscard]] bool SaveTab(int index, const std::wstring& content, bool forceDialog) {
    if (index < 0 || index >= static_cast<int>(g_app.tabs.size())) {
        return false;
    }
    Tab& tab = g_app.tabs[static_cast<size_t>(index)];
    std::wstring target = tab.path;
    if (forceDialog || target.empty()) {
        if (!ShowSaveAsDialog(target, TabNameOf(tab))) {
            return false;
        }
    }

    if (!WriteDocumentFile(target, content, tab.usesCrLf)) {
        std::wstring message = L"JustViewMD could not save:\n\n";
        message += target;
        message += L"\n\nThe file may be read-only or in use by another program.";
        ShowErrorBox(g_app.window, message);
        return false;
    }

    tab.path = target;
    tab.mirror = content;
    tab.mirrorValid = true;
    tab.dirty = false;
    RememberDirectoryOf(target);
    UpdateWindowTitle();

    std::wstring message = L"{\"type\":\"saved\",\"index\":";
    message += std::to_wstring(index);
    message += L",\"path\":\"";
    message += JsonEscape(target);
    message += L"\",\"name\":\"";
    message += JsonEscape(FileNameOf(target));
    message += L"\"}";
    SendToWeb(message);
    SendTabList();
    SaveSession();
    DebugLog(L"Saved a tab");
    return true;
}

// Yes / No / Cancel prompt used before anything that would lose a buffer.
[[nodiscard]] bool ConfirmSaveForTab(int index, const std::wstring& content) {
    if (index < 0 || index >= static_cast<int>(g_app.tabs.size())) {
        return true;
    }
    std::wstring question = L"Save changes to ";
    question += TabNameOf(g_app.tabs[static_cast<size_t>(index)]);
    question += L"?";
    const int answer = ::MessageBoxW(g_app.window, question.c_str(), kAppName,
                                     MB_YESNOCANCEL | MB_ICONWARNING | MB_SETFOREGROUND);
    if (answer == IDCANCEL) {
        return false;
    }
    if (answer == IDNO) {
        return true;
    }
    return SaveTab(index, content, false);
}

[[nodiscard]] bool ShowOpenDialog(std::wstring& path) {
    wchar_t buffer[32768] = {};
    const Tab* tab = ActiveTab();
    if (tab != nullptr && !tab->path.empty()) {
        (void)::wcsncpy_s(buffer, ARRAYSIZE(buffer), tab->path.c_str(), _TRUNCATE);
    }

    OPENFILENAMEW dialog{};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = g_app.window;
    dialog.lpstrFilter = L"Markdown (*.md;*.markdown;*.mdx)\0*.md;*.markdown;*.mdx\0"
                         L"Text (*.txt;*.text)\0*.txt;*.text\0"
                         L"All files (*.*)\0*.*\0\0";
    dialog.lpstrFile = buffer;
    dialog.nMaxFile = ARRAYSIZE(buffer);
    dialog.lpstrDefExt = L"md";
    dialog.lpstrTitle = L"Open Markdown file";
    dialog.lpstrInitialDir = g_lastDirectory.empty() ? nullptr : g_lastDirectory.c_str();
    dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER | OFN_DONTADDTORECENT | OFN_NOCHANGEDIR;

    if (!::GetOpenFileNameW(&dialog)) {
        return false;
    }
    path.assign(buffer);
    return true;
}

void OpenFileModal() {
    std::wstring path;
    if (!ShowOpenDialog(path)) {
        return;
    }
    (void)OpenPathInTab(path, true);
}

// --- Closing tabs -----------------------------------------------------------

// Removes a tab.  The page hears about the removal first, so its own list is
// spliced at the same index before the new metadata arrives.
void RemoveTab(int index) {
    if (index < 0 || index >= static_cast<int>(g_app.tabs.size())) {
        return;
    }
    g_app.tabs.erase(g_app.tabs.begin() + static_cast<std::ptrdiff_t>(index));

    if (g_app.tabs.empty()) {
        // Closing the last tab leaves a fresh empty one behind, never an empty
        // window: there is always somewhere to type.
        g_app.tabs.push_back(MakeUntitledTab());
        g_app.activeTab = 0;
        UpdateWindowTitle();
        SendTabList();
        SendDocumentToWeb(0, std::wstring(), false);
        SaveSession();
        return;
    }

    if (g_app.activeTab > index) {
        --g_app.activeTab;
    }
    if (g_app.activeTab >= static_cast<int>(g_app.tabs.size())) {
        g_app.activeTab = static_cast<int>(g_app.tabs.size()) - 1;
    }

    std::wstring message = L"{\"type\":\"closeTab\",\"index\":";
    message += std::to_wstring(index);
    message += L",\"active\":";
    message += std::to_wstring(g_app.activeTab);
    message += L"}";
    SendToWeb(message);
    SendTabList();
    UpdateWindowTitle();
    SaveSession();
}

// The page asked to close one tab and sent its text along, so the prompt about
// unsaved work needs no further round trip.
void CloseTabFlow(int index, const std::wstring& content) {
    if (index < 0 || index >= static_cast<int>(g_app.tabs.size())) {
        return;
    }
    Tab& tab = g_app.tabs[static_cast<size_t>(index)];
    tab.mirror = content;
    tab.mirrorValid = true;
    if (tab.dirty && !ConfirmSaveForTab(index, content)) {
        return;
    }
    RemoveTab(index);
}

// Prompts about every tab with unsaved work, in strip order.  "skip" is a tab
// that is being kept alive, which is how "close other tabs" works.
[[nodiscard]] bool ConfirmAllDirtyTabs(int skip) {
    for (int index = 0; index < static_cast<int>(g_app.tabs.size()); ++index) {
        if (index == skip || !g_app.tabs[static_cast<size_t>(index)].dirty) {
            continue;
        }
        if (!ConfirmSaveForTab(index, g_app.tabs[static_cast<size_t>(index)].mirror)) {
            return false;
        }
    }
    return true;
}

// Collapses everything into a single empty tab.
void CloseAllFlow() {
    if (!ConfirmAllDirtyTabs(-1)) {
        return;
    }
    g_app.tabs.clear();
    g_app.tabs.push_back(MakeUntitledTab());
    g_app.activeTab = 0;
    UpdateWindowTitle();
    SendTabList();
    SendDocumentToWeb(0, std::wstring(), false);
    SaveSession();
}

// Keeps one tab and drops the rest.  The page collapses its own list first so
// the text of the surviving tab travels nowhere.
void CloseOthersFlow(int keep) {
    if (keep < 0 || keep >= static_cast<int>(g_app.tabs.size())) {
        return;
    }
    if (!ConfirmAllDirtyTabs(keep)) {
        return;
    }
    const Tab kept = g_app.tabs[static_cast<size_t>(keep)];

    std::wstring message = L"{\"type\":\"collapse\",\"keep\":";
    message += std::to_wstring(keep);
    message += L"}";
    SendToWeb(message);

    g_app.tabs.clear();
    g_app.tabs.push_back(Tab{});
    g_app.activeTab = 0;
    Tab& tab = g_app.tabs[0];
    tab.path = kept.path;
    tab.untitledName = kept.untitledName;
    tab.mirror = kept.mirror;      // fresh: the page just reported every buffer
    tab.mirrorValid = kept.mirrorValid;
    tab.usesCrLf = kept.usesCrLf;

    UpdateWindowTitle();
    SendTabList();
    SendDocumentToWeb(0, tab.mirror, false);
    SaveSession();
}

// Reopens the files of the previous run.  Files that have gone missing are
// skipped quietly - a wall of message boxes about deleted files helps nobody.
[[nodiscard]] bool RestoreSessionTabs() {
    if (g_app.sessionPaths.empty()) {
        return false;
    }
    const std::vector<std::wstring> paths = g_app.sessionPaths;
    const std::wstring activePath = g_app.sessionActive;

    g_app.tabs.clear();
    for (const std::wstring& path : paths) {
        if (!FileExists(path) || TabIndexOfPath(path) >= 0) {
            continue;
        }
        Document document;
        if (ReadDocumentFile(path, document) != ReadStatus::Ok) {
            continue;
        }
        g_app.tabs.push_back(Tab{});
        Tab& tab = g_app.tabs.back();
        tab.path = path;
        tab.mirror = document.text;
        tab.mirrorValid = true;
        tab.usesCrLf = document.usesCrLf;
    }
    if (g_app.tabs.empty()) {
        return false;
    }

    g_app.activeTab = 0;
    if (!activePath.empty()) {
        for (size_t index = 0; index < g_app.tabs.size(); ++index) {
            const std::wstring& candidate = g_app.tabs[index].path;
            if (::CompareStringOrdinal(candidate.c_str(), static_cast<int>(candidate.size()),
                                       activePath.c_str(), static_cast<int>(activePath.size()),
                                       TRUE) == CSTR_EQUAL) {
                g_app.activeTab = static_cast<int>(index);
                break;
            }
        }
    }

    UpdateWindowTitle();
    SendTabList();
    // The text of every tab, with the active one last so that the window shows
    // it once all the others have been handed over.
    for (size_t index = 0; index < g_app.tabs.size(); ++index) {
        if (static_cast<int>(index) == g_app.activeTab) {
            continue;
        }
        SendDocumentToWeb(static_cast<int>(index), g_app.activeTab, g_app.tabs[index].mirror, false);
    }
    SendDocumentToWeb(g_app.activeTab, g_app.activeTab,
                      g_app.tabs[static_cast<size_t>(g_app.activeTab)].mirror, false);
    DebugLog(L"Restored the session");
    return true;
}

// ===========================================================================
//  10. WebView2 environment options and event handlers
// ===========================================================================

// ICoreWebView2EnvironmentOptions: supplies the Chromium switches.  Written by
// hand because WebView2EnvironmentOptions.h needs wrl/implements.h, which the
// MinGW toolchain does not ship.
class EnvironmentOptions final : public ComHandler<EnvironmentOptions, ICoreWebView2EnvironmentOptions> {
public:
    EnvironmentOptions(std::wstring arguments, std::wstring targetVersion)
        : m_arguments(std::move(arguments)), m_targetVersion(std::move(targetVersion)) {}

    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2EnvironmentOptions; }

    HRESULT STDMETHODCALLTYPE get_AdditionalBrowserArguments(LPWSTR* value) noexcept override {
        return CopyOut(m_arguments, value);
    }
    HRESULT STDMETHODCALLTYPE put_AdditionalBrowserArguments(LPCWSTR value) noexcept override {
        m_arguments = (value != nullptr) ? value : L"";
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_Language(LPWSTR* value) noexcept override {
        return CopyOut(m_language, value);
    }
    HRESULT STDMETHODCALLTYPE put_Language(LPCWSTR value) noexcept override {
        m_language = (value != nullptr) ? value : L"";
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_TargetCompatibleBrowserVersion(LPWSTR* value) noexcept override {
        return CopyOut(m_targetVersion, value);
    }
    HRESULT STDMETHODCALLTYPE put_TargetCompatibleBrowserVersion(LPCWSTR value) noexcept override {
        m_targetVersion = (value != nullptr) ? value : L"";
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_AllowSingleSignOnUsingOSPrimaryAccount(BOOL* value) noexcept override {
        if (value == nullptr) {
            return E_POINTER;
        }
        *value = m_singleSignOn;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE put_AllowSingleSignOnUsingOSPrimaryAccount(BOOL value) noexcept override {
        m_singleSignOn = value;
        return S_OK;
    }

private:
    static HRESULT CopyOut(const std::wstring& text, LPWSTR* value) noexcept {
        if (value == nullptr) {
            return E_POINTER;
        }
        const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
        auto* copy = static_cast<LPWSTR>(::CoTaskMemAlloc(bytes));
        if (copy == nullptr) {
            return E_OUTOFMEMORY;
        }
        std::memcpy(copy, text.c_str(), bytes);
        *value = copy;
        return S_OK;
    }

    std::wstring m_arguments;
    std::wstring m_language = L"en-US";
    std::wstring m_targetVersion;
    BOOL m_singleSignOn = FALSE;
};

[[nodiscard]] std::wstring HexValue(HRESULT value) {
    constexpr wchar_t kDigits[] = L"0123456789abcdef";
    std::wstring text = L"0x";
    const auto raw = static_cast<unsigned long>(value);
    bool started = false;
    for (int shift = 28; shift >= 0; shift -= 4) {
        const unsigned digit = (raw >> shift) & 0xFul;
        if (digit != 0 || started || shift == 0) {
            started = true;
            text += kDigits[digit];
        }
    }
    return text;
}

void ReportFatalWebViewError(HRESULT errorCode) {
    std::wstring message =
        L"JustViewMD could not start the Microsoft Edge WebView2 engine.\n\n";
    if (errorCode == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || errorCode == E_FAIL) {
        message += L"The WebView2 Runtime does not appear to be installed.\n\n"
                   L"Install Microsoft's free \"Evergreen WebView2 Runtime\" and try again.";
    } else {
        message += L"Error code: ";
        message += HexValue(errorCode);
    }
    DebugLog(L"Fatal: " + message);
    ShowErrorBox(g_app.window, message);
    ::PostQuitMessage(1);
}

void SetupWebViewAfterControllerCreated();
void HandleWebMessage(const std::wstring& json);
void HandleCloseRequest();
void ApplyWindowTheme();
void DropFilePath(const std::wstring& path);
void RegisterWebViewDropTargets();
[[nodiscard]] bool UrlToLocalPath(const std::wstring& uri, std::wstring& path);
[[nodiscard]] std::wstring FileUrlFromPath(const std::wstring& path);

class ControllerCompletedHandler final
    : public ComHandler<ControllerCompletedHandler, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
public:
    static const IID& InterfaceId() noexcept {
        return IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler;
    }

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, ICoreWebView2Controller* controller) noexcept override {
        DebugLog(L"Controller creation completed: " + HexValue(errorCode));
        if (FAILED(errorCode) || controller == nullptr) {
            ReportFatalWebViewError(errorCode);
            return S_OK;
        }
        controller->AddRef();
        g_app.controller.Attach(controller);

        ICoreWebView2* webview = nullptr;
        if (FAILED(controller->get_CoreWebView2(&webview)) || webview == nullptr) {
            ReportFatalWebViewError(E_FAIL);
            return S_OK;
        }
        g_app.webview.Attach(webview);  // get_CoreWebView2 hands us a reference

        SetupWebViewAfterControllerCreated();
        return S_OK;
    }
};

class EnvironmentCompletedHandler final
    : public ComHandler<EnvironmentCompletedHandler, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
public:
    static const IID& InterfaceId() noexcept {
        return IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler;
    }

    HRESULT STDMETHODCALLTYPE Invoke(HRESULT errorCode, ICoreWebView2Environment* environment) noexcept override {
        DebugLog(L"Environment creation completed: " + HexValue(errorCode));
        if (FAILED(errorCode) || environment == nullptr) {
            ReportFatalWebViewError(errorCode);
            return S_OK;
        }
        environment->AddRef();
        g_app.environment.Attach(environment);

        LPWSTR version = nullptr;
        if (SUCCEEDED(environment->get_BrowserVersionString(&version)) && version != nullptr) {
            DebugLog(std::wstring(L"WebView2 runtime version: ") + version);
            ::CoTaskMemFree(version);
        }

        auto* controllerHandler = new ControllerCompletedHandler();
        const HRESULT result = environment->CreateCoreWebView2Controller(g_app.window, controllerHandler);
        controllerHandler->Release();  // our reference; the engine keeps its own
        if (FAILED(result)) {
            ReportFatalWebViewError(result);
        }
        return S_OK;
    }
};

class WebMessageReceivedHandler final
    : public ComHandler<WebMessageReceivedHandler, ICoreWebView2WebMessageReceivedEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2WebMessageReceivedEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) noexcept override {
        if (args == nullptr) {
            return S_OK;
        }
        LPWSTR raw = nullptr;
        if (SUCCEEDED(args->get_WebMessageAsJson(&raw)) && raw != nullptr) {
            HandleWebMessage(std::wstring(raw));
            ::CoTaskMemFree(raw);
        }
        return S_OK;
    }
};

// Never let the embedded browser navigate away from the application: links to
// the web go to the default browser, and a dropped local file is turned into a
// "load this document" request instead of a navigation.
class NavigationStartingHandler final
    : public ComHandler<NavigationStartingHandler, ICoreWebView2NavigationStartingEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2NavigationStartingEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) noexcept override {
        if (args == nullptr) {
            return S_OK;
        }
        LPWSTR raw = nullptr;
        if (FAILED(args->get_Uri(&raw)) || raw == nullptr) {
            return S_OK;
        }
        const std::wstring uri(raw);
        ::CoTaskMemFree(raw);

        if (uri == kStartUrl || uri.rfind(kAssetOrigin, 0) == 0 || uri == L"about:blank") {
            return S_OK;
        }

        if (uri.rfind(L"file://", 0) == 0) {
            (void)args->put_Cancel(TRUE);
            std::wstring path;
            if (UrlToLocalPath(uri, path)) {
                DropFilePath(path);
            }
            return S_OK;
        }

        (void)args->put_Cancel(TRUE);
        const HINSTANCE launched = ::ShellExecuteW(nullptr, L"open", uri.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        if (reinterpret_cast<INT_PTR>(launched) <= 32) {
            DebugLog(L"ShellExecuteW failed for an external link");
        }
        return S_OK;
    }
};

class NewWindowRequestedHandler final
    : public ComHandler<NewWindowRequestedHandler, ICoreWebView2NewWindowRequestedEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2NewWindowRequestedEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) noexcept override {
        if (args == nullptr) {
            return S_OK;
        }
        (void)args->put_Handled(TRUE);
        LPWSTR raw = nullptr;
        if (SUCCEEDED(args->get_Uri(&raw)) && raw != nullptr) {
            const std::wstring uri(raw);
            ::CoTaskMemFree(raw);
            (void)::ShellExecuteW(nullptr, L"open", uri.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        }
        return S_OK;
    }
};

// The page only ever needs the clipboard, and only for its own origin.
class PermissionRequestedHandler final
    : public ComHandler<PermissionRequestedHandler, ICoreWebView2PermissionRequestedEventHandler> {
public:
    static const IID& InterfaceId() noexcept { return IID_ICoreWebView2PermissionRequestedEventHandler; }

    HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) noexcept override {
        if (args == nullptr) {
            return S_OK;
        }
        COREWEBVIEW2_PERMISSION_STATE state = COREWEBVIEW2_PERMISSION_STATE_DENY;
        COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
        (void)args->get_PermissionKind(&kind);
        LPWSTR raw = nullptr;
        if (kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ && SUCCEEDED(args->get_Uri(&raw)) && raw != nullptr) {
            const std::wstring uri(raw);
            if (uri.rfind(kAssetOrigin, 0) == 0) {
                state = COREWEBVIEW2_PERMISSION_STATE_ALLOW;
            }
        }
        if (raw != nullptr) {
            ::CoTaskMemFree(raw);
        }
        (void)args->put_State(state);
        return S_OK;
    }
};

// ===========================================================================
//  11. WebView2 start-up
// ===========================================================================

[[nodiscard]] std::wstring FileUrlFromPath(const std::wstring& path) {
    std::wstring url = L"file:///";
    url.reserve(path.size() + 8);
    for (const wchar_t ch : path) {
        url += (ch == L'\\') ? L'/' : ch;
    }
    return url;
}

[[nodiscard]] bool UrlToLocalPath(const std::wstring& uri, std::wstring& path) {
    wchar_t buffer[32768] = {};
    DWORD length = ARRAYSIZE(buffer);
    const HRESULT result = ::PathCreateFromUrlW(uri.c_str(), buffer, &length, 0);
    if (FAILED(result)) {
        return false;
    }
    path.assign(buffer, length);
    return !path.empty();
}

void SetupWebViewAfterControllerCreated() {
    ICoreWebView2Controller* controller = g_app.controller.Get();
    ICoreWebView2* webview = g_app.webview.Get();
    if (controller == nullptr || webview == nullptr) {
        return;
    }

    RECT bounds{};
    ::GetClientRect(g_app.window, &bounds);
    (void)controller->put_Bounds(bounds);
    (void)controller->put_IsVisible(TRUE);
    (void)controller->put_ZoomFactor(g_app.zoomFactor);

    // Dark default background: no white flash before the page paints.
    ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(controller->QueryInterface(IID_ICoreWebView2Controller2,
                                             reinterpret_cast<void**>(controller2.Put())))) {
        COREWEBVIEW2_COLOR background{};
        background.A = 255;
        background.R = GetRValue(kDarkWindowColor);
        background.G = GetGValue(kDarkWindowColor);
        background.B = GetBValue(kDarkWindowColor);
        (void)controller2->put_DefaultBackgroundColor(background);
    }

    // Browser-shaped affordances are switched off: this is an application, not
    // a browser with a Markdown page in it.
    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(webview->get_Settings(settings.Put())) && settings) {
        (void)settings->put_AreDefaultContextMenusEnabled(FALSE);
        (void)settings->put_AreDevToolsEnabled(g_app.devToolsEnabled ? TRUE : FALSE);
        (void)settings->put_IsStatusBarEnabled(FALSE);
        (void)settings->put_IsZoomControlEnabled(FALSE);

        ComPtr<ICoreWebView2Settings3> settings3;
        if (SUCCEEDED(settings->QueryInterface(IID_ICoreWebView2Settings3,
                                               reinterpret_cast<void**>(settings3.Put())))) {
            (void)settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
        }
    }

    // Events -----------------------------------------------------------------
    auto* messageHandler = new WebMessageReceivedHandler();
    if (SUCCEEDED(webview->add_WebMessageReceived(messageHandler, &g_app.messageToken))) {
        messageHandler->Release();
    } else {
        messageHandler->Release();
        DebugLog(L"add_WebMessageReceived failed");
    }

    auto* navigationHandler = new NavigationStartingHandler();
    (void)webview->add_NavigationStarting(navigationHandler, &g_app.navigationToken);
    navigationHandler->Release();

    auto* newWindowHandler = new NewWindowRequestedHandler();
    (void)webview->add_NewWindowRequested(newWindowHandler, &g_app.newWindowToken);
    newWindowHandler->Release();

    auto* permissionHandler = new PermissionRequestedHandler();
    (void)webview->add_PermissionRequested(permissionHandler, &g_app.permissionToken);
    permissionHandler->Release();

    // File drops are handled by the host window (see DocumentDropTarget), so the
    // WebView2 must not swallow them.  Without this, dropping a .md file would
    // navigate the embedded browser to the file.
    ComPtr<ICoreWebView2Controller4> controller4;
    if (SUCCEEDED(controller->QueryInterface(IID_ICoreWebView2Controller4,
                                             reinterpret_cast<void**>(controller4.Put())))) {
        const HRESULT dropResult = controller4->put_AllowExternalDrop(FALSE);
        BOOL allowExternalDrop = TRUE;
        (void)controller4->get_AllowExternalDrop(&allowExternalDrop);
        DebugLog(dropResult == S_OK && allowExternalDrop == FALSE
                     ? L"External drops are handled by the host window"
                     : L"put_AllowExternalDrop(FALSE) did not take effect");
    } else {
        DebugLog(L"ICoreWebView2Controller4 is unavailable; drops rely on WM_DROPFILES");
    }

    // Also register the drop target on the WebView2's own child windows; see the
    // comment on the function.  Called again once the page has painted, because
    // some of those windows only exist then.
    RegisterWebViewDropTargets();

    // assets/ becomes https://app.local/ -------------------------------------
    bool hostMapped = false;
    ComPtr<ICoreWebView2_3> webview3;
    if (SUCCEEDED(webview->QueryInterface(IID_ICoreWebView2_3, reinterpret_cast<void**>(webview3.Put())))) {
        hostMapped = SUCCEEDED(webview3->SetVirtualHostNameToFolderMapping(
            kVirtualHost, g_app.assetsDirectory.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW));

        // The downloaded pictures become https://cache.local/ so the page can
        // show one with a plain <img> tag once the host has fetched it.
        if (!g_app.imageCacheDirectory.empty() &&
            FAILED(webview3->SetVirtualHostNameToFolderMapping(
                kImageCacheHost, g_app.imageCacheDirectory.c_str(),
                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW))) {
            DebugLog(L"Could not map the image cache folder");
        }
    }

    if (hostMapped) {
        (void)webview->Navigate(kStartUrl);
    } else {
        // Very old runtime: fall back to a file URL.  Everything still works
        // offline, but font loading is less reliable.
        DebugLog(L"Virtual host mapping unavailable; falling back to file://");
        const std::wstring page = FileUrlFromPath(JoinPath(g_app.assetsDirectory, L"index.html"));
        (void)webview->Navigate(page.c_str());
    }

    // Browser accelerator keys are off, so F12 and Ctrl+Shift+I do nothing:
    // --devtools opens the tools itself instead.
    if (g_app.devToolsEnabled) {
        (void)webview->OpenDevToolsWindow();
    }
}

[[nodiscard]] HRESULT StartWebViewEnvironment(const wchar_t* targetVersion) {
    auto* options = new EnvironmentOptions(kBrowserArguments, targetVersion);
    auto* completedHandler = new EnvironmentCompletedHandler();
    const HRESULT result = CreateEnvironmentWithOptions(
        nullptr, g_app.userDataDirectory.c_str(), options, completedHandler);
    options->Release();
    completedHandler->Release();
    DebugLog(std::wstring(L"CreateCoreWebView2EnvironmentWithOptions(") + targetVersion +
             L"): " + HexValue(result) + L", user data: " + g_app.userDataDirectory);
    return result;
}

[[nodiscard]] bool StartWebViewEngine() {
    // Two attempts, because the one thing that stops the engine from starting at
    // all is a runtime older than the version the app was built against.  The
    // second attempt asks for any runtime the machine has; if the first one
    // succeeded, the fallback never runs.
    HRESULT result = StartWebViewEnvironment(kTargetBrowserVersion);
    if (FAILED(result)) {
        DebugLog(L"Retrying with the oldest supported runtime version");
        result = StartWebViewEnvironment(kOldestBrowserVersion);
    }
    if (FAILED(result)) {
        ReportFatalWebViewError(result);
        return false;
    }
    return true;
}

// ===========================================================================
//  12. Work that a drop starts
// ===========================================================================

// Opens a dropped / linked file.  It gets its own tab, so a drop can never
// lose work that is already open.
void DropFilePath(const std::wstring& path) {
    DebugLog(L"DropFilePath: " + path);
    if (!FileExists(path)) {
        DebugLog(L"DropFilePath: the file does not exist");
        return;
    }
    if (!HasTextExtension(ToLower(path))) {
        DebugLog(L"DropFilePath: unsupported extension");
        std::wstring message = L"JustViewMD opens Markdown and plain-text documents.\n\n";
        message += path;
        ShowErrorBox(g_app.window, message);
        return;
    }
    (void)OpenPathInTab(path, true);
}

// ===========================================================================
//  13. Message dispatch from the page
// ===========================================================================

void SendDefaultAppState(std::wstring_view notice) {
    std::wstring message = L"{\"type\":\"defaultAppState\",\"value\":";
    message += IsDefaultApplication() ? L"true" : L"false";
    message += L",\"notice\":\"";
    message += JsonEscape(notice);
    message += L"\"}";
    SendToWeb(message);
}

// The checkbox in the Options menu.  Windows gets the first word: when another
// application still owns the extension (UserChoice), the answer says so instead
// of claiming a change that did not happen.
void HandleSetDefaultApp(bool enable) {
    if (enable) {
        (void)RegisterDefaultApplication();
    } else {
        (void)UnregisterDefaultApplication();
    }
    std::wstring notice;
    if (enable && !IsDefaultApplication()) {
        notice = DescribeDefaultOverride();
        if (notice.empty()) {
            notice = L"Windows did not accept the change for every extension.";
        }
    }
    SendDefaultAppState(notice);
}

// An option changed in the page: remember it, and apply the parts of it that
// belong to the window rather than to the document.
void ApplyOptionFromPage(const std::wstring& name, const std::wstring& value) {
    const bool flag = (value == L"1" || value == L"true");
    if (name == L"viewMode") {
        if (value != L"split" && value != L"editor" && value != L"preview") {
            return;
        }
        g_app.viewMode = value;
    } else if (name == L"darkMode") {
        g_app.darkMode = flag;
        ApplyWindowTheme();
    } else if (name == L"keepOpenedFiles" || name == L"keepOpened") {
        g_app.keepOpenedFiles = flag;
    } else if (name == L"startBlank") {
        g_app.startBlank = flag;
    } else if (name == L"wrap") {
        g_app.wrapLines = flag;
    } else {
        return;
    }
    SaveOptions();
}

void FinishClose() {
    SaveSession();
    ::DestroyWindow(g_app.window);
}

void HandleCloseRequest() {
    bool anyDirty = false;
    for (const Tab& tab : g_app.tabs) {
        anyDirty = anyDirty || tab.dirty;
    }
    if (!anyDirty) {
        FinishClose();
        return;
    }
    if (g_app.webReady) {
        RequestAllContents(L"close");
        // If the page does not answer (hung renderer), fall back to the mirrors
        // so the user is never trapped in the application.
        ::SetTimer(g_app.window, kTimerCloseFallback, kCloseFallbackMilliseconds, nullptr);
        return;
    }
    if (ConfirmAllDirtyTabs(-1)) {
        FinishClose();
    }
}

void HandleWebMessage(const std::wstring& json) {
    const JsonReader reader(json);
    const std::wstring type = reader.GetString(L"type");
    if (type.empty()) {
        return;
    }
    if (type != L"snapshot") {  // snapshot arrives on every edit
        DebugLog(L"Web message: " + type);
    }

    if (type == L"ready") {
        g_app.webReady = true;
        ::KillTimer(g_app.window, kTimerCloseFallback);
        // The page has painted by now, so every WebView2 child window exists.
        RegisterWebViewDropTargets();
        SendOptionsToWeb();
        SendImageCacheSize();
        SendUpdateState(false);
        if (!g_app.updateCheckedOnStart) {
            // The check runs once per start, in the background, and says nothing
            // unless it has something to show (the Options menu carries it).
            g_app.updateCheckedOnStart = true;
            if (g_app.checkForUpdate) {
                RequestUpdateCheck(false);
            }
        }
        if (g_app.webEverLoaded) {
            // The renderer restarted: hand every tab back so nothing is lost.
            SendTabList();
            for (size_t index = 0; index < g_app.tabs.size(); ++index) {
                const Tab& tab = g_app.tabs[index];
                SendDocumentToWeb(static_cast<int>(index), g_app.activeTab,
                                  tab.mirrorValid ? tab.mirror : std::wstring(), tab.dirty);
            }
        } else {
            g_app.webEverLoaded = true;
            bool loaded = false;
            if (!g_app.pendingOpenPath.empty()) {
                const std::wstring path = g_app.pendingOpenPath;
                g_app.pendingOpenPath.clear();
                loaded = OpenPathInTab(path, true);
            }
            if (!loaded && g_app.keepOpenedFiles) {
                loaded = RestoreSessionTabs();
            }
            if (!loaded) {
                if (g_app.startBlank) {
                    LoadBlankTab();
                } else {
                    LoadWelcomeTab();
                }
            }
        }
        if (g_app.controller) {
            (void)g_app.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
        return;
    }

    if (type == L"dirty") {
        const int index = static_cast<int>(reader.GetNumber(L"index", -1));
        if (index >= 0 && index < static_cast<int>(g_app.tabs.size())) {
            g_app.tabs[static_cast<size_t>(index)].dirty = reader.GetBool(L"value");
            UpdateWindowTitle();
        }
        return;
    }
    if (type == L"snapshot") {
        const int index = static_cast<int>(reader.GetNumber(L"index", g_app.activeTab));
        if (index >= 0 && index < static_cast<int>(g_app.tabs.size())) {
            Tab& tab = g_app.tabs[static_cast<size_t>(index)];
            tab.mirror = reader.GetString(L"content");
            tab.mirrorValid = true;
        }
        return;
    }
    if (type == L"save") {
        (void)SaveTab(g_app.activeTab, reader.GetString(L"content"), false);
        return;
    }
    if (type == L"saveAs") {
        (void)SaveTab(g_app.activeTab, reader.GetString(L"content"), true);
        return;
    }
    if (type == L"open") {
        OpenFileModal();
        return;
    }
    if (type == L"newTab") {
        NewTabFlow();
        return;
    }
    if (type == L"reload") {
        ReloadActiveTab();
        return;
    }
    if (type == L"tabSelect") {
        ActivateTab(static_cast<int>(reader.GetNumber(L"index", g_app.activeTab)));
        return;
    }
    if (type == L"tabClose") {
        CloseTabFlow(static_cast<int>(reader.GetNumber(L"index", -1)), reader.GetString(L"content"));
        return;
    }
    if (type == L"closeAll") {
        // Prompting about unsaved work needs every buffer, so ask for them.
        RequestAllContents(L"closeAll");
        return;
    }
    if (type == L"closeOthers") {
        g_app.pendingKeepTab = static_cast<int>(reader.GetNumber(L"keep", -1));
        RequestAllContents(L"closeOthers");
        return;
    }
    if (type == L"setting") {
        ApplyOptionFromPage(reader.GetString(L"name"), reader.GetString(L"value"));
        return;
    }
    if (type == L"setDefaultApp") {
        HandleSetDefaultApp(reader.GetBool(L"value"));
        return;
    }
    if (type == L"openDefaultApps") {
        (void)::ShellExecuteW(g_app.window, L"open", L"ms-settings:defaultapps", nullptr, nullptr,
                              SW_SHOWNORMAL);
        return;
    }
    if (type == L"zoom") {
        ApplyZoom(reader.GetNumber(L"value", g_app.zoomFactor));
        return;
    }
    if (type == L"zoomIn") {
        ApplyZoom(g_app.zoomFactor + kZoomStep);
        return;
    }
    if (type == L"zoomOut") {
        ApplyZoom(g_app.zoomFactor - kZoomStep);
        return;
    }
    if (type == L"zoomReset") {
        ApplyZoom(1.0);
        return;
    }
    if (type == L"fetchImage") {
        RequestImage(reader.GetString(L"url"));
        return;
    }
    if (type == L"cacheStats") {
        SendImageCacheSize();
        return;
    }
    if (type == L"openCacheFolder") {
        OpenImageCacheFolder();
        return;
    }
    if (type == L"checkForUpdate") {
        RequestUpdateCheck(true);
        return;
    }
    if (type == L"openReleasePage") {
        OpenReleasePage();
        return;
    }
    if (type == L"log") {
        DebugLog(reader.GetString(L"text"));
        return;
    }
    if (type == L"content") {
        const int index = static_cast<int>(reader.GetNumber(L"index", -1));
        if (index >= 0 && index < static_cast<int>(g_app.tabs.size())) {
            Tab& tab = g_app.tabs[static_cast<size_t>(index)];
            tab.mirror = reader.GetString(L"content");
            tab.mirrorValid = true;
        }
        if (g_app.pendingContentReason.empty()) {
            return;  // an answer to a request that has already been dealt with
        }
        --g_app.pendingContentCount;
        if (g_app.pendingContentCount > 0) {
            return;  // more buffers are on the way
        }
        ::KillTimer(g_app.window, kTimerCloseFallback);
        const std::wstring reason = g_app.pendingContentReason;
        g_app.pendingContentReason.clear();
        g_app.pendingContentCount = 0;

        if (reason == L"close") {
            if (ConfirmAllDirtyTabs(-1)) {
                FinishClose();
            }
        } else if (reason == L"closeAll") {
            CloseAllFlow();
        } else if (reason == L"closeOthers") {
            const int keep = g_app.pendingKeepTab;
            g_app.pendingKeepTab = -1;
            CloseOthersFlow(keep);
        }
        return;
    }
}

// ===========================================================================
//  14. File drops (OLE target on the host window)
// ===========================================================================

[[nodiscard]] bool DataObjectHasFormat(IDataObject* data, CLIPFORMAT format) {
    FORMATETC candidate{};
    candidate.cfFormat = format;
    candidate.ptd = nullptr;
    candidate.dwAspect = DVASPECT_CONTENT;
    candidate.lindex = -1;
    candidate.tymed = TYMED_HGLOBAL;
    return data->QueryGetData(&candidate) == S_OK;
}

[[nodiscard]] bool ReadFileDropPaths(IDataObject* data, std::vector<std::wstring>& paths) {
    FORMATETC format{};
    format.cfFormat = CF_HDROP;
    format.ptd = nullptr;
    format.dwAspect = DVASPECT_CONTENT;
    format.lindex = -1;
    format.tymed = TYMED_HGLOBAL;

    STGMEDIUM medium{};
    if (FAILED(data->GetData(&format, &medium))) {
        return false;
    }
    bool ok = false;
    if (medium.tymed == TYMED_HGLOBAL && medium.hGlobal != nullptr) {
        const HDROP drop = static_cast<HDROP>(::GlobalLock(medium.hGlobal));
        if (drop != nullptr) {
            const UINT count = ::DragQueryFileW(drop, 0xFFFFFFFFu, nullptr, 0);
            for (UINT index = 0; index < count; ++index) {
                const UINT length = ::DragQueryFileW(drop, index, nullptr, 0);
                if (length == 0) {
                    continue;
                }
                std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1, L'\0');
                if (::DragQueryFileW(drop, index, buffer.data(), length + 1) == length) {
                    paths.emplace_back(buffer.data());
                }
            }
            ::GlobalUnlock(medium.hGlobal);
            ok = !paths.empty();
        }
    }
    ::ReleaseStgMedium(&medium);
    return ok;
}

[[nodiscard]] bool ReadUnicodeText(IDataObject* data, std::wstring& text) {
    FORMATETC format{};
    format.cfFormat = CF_UNICODETEXT;
    format.ptd = nullptr;
    format.dwAspect = DVASPECT_CONTENT;
    format.lindex = -1;
    format.tymed = TYMED_HGLOBAL;

    STGMEDIUM medium{};
    if (FAILED(data->GetData(&format, &medium))) {
        return false;
    }
    bool ok = false;
    if (medium.tymed == TYMED_HGLOBAL && medium.hGlobal != nullptr) {
        const auto* locked = static_cast<const wchar_t*>(::GlobalLock(medium.hGlobal));
        if (locked != nullptr) {
            const size_t available = ::GlobalSize(medium.hGlobal) / sizeof(wchar_t);
            size_t length = 0;
            while (length < available && locked[length] != L'\0') {
                ++length;
            }
            text.assign(locked, length);
            ::GlobalUnlock(medium.hGlobal);
            ok = true;
        }
    }
    ::ReleaseStgMedium(&medium);
    return ok;
}

class DocumentDropTarget final : public ComHandler<DocumentDropTarget, IDropTarget> {
public:
    static const IID& InterfaceId() noexcept { return IID_IDropTarget; }

    HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* data, DWORD keyState, POINTL point, DWORD* effect) noexcept override {
        UNREFERENCED_PARAMETER(keyState);
        UNREFERENCED_PARAMETER(point);
        m_hasFiles = (data != nullptr) && DataObjectHasFormat(data, CF_HDROP);
        m_hasText = (data != nullptr) && !m_hasFiles && DataObjectHasFormat(data, CF_UNICODETEXT);
        const bool supported = m_hasFiles || m_hasText;
        m_effect = supported ? DROPEFFECT_COPY : DROPEFFECT_NONE;
        if (effect != nullptr) {
            *effect = m_effect;
        }
        DebugLog(m_hasFiles ? L"DragEnter with files"
                            : (m_hasText ? L"DragEnter with text" : L"DragEnter with an unsupported payload"));
        ShowOverlay(supported);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragOver(DWORD keyState, POINTL point, DWORD* effect) noexcept override {
        UNREFERENCED_PARAMETER(keyState);
        UNREFERENCED_PARAMETER(point);
        if (effect != nullptr) {
            *effect = m_effect;
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE DragLeave() noexcept override {
        ShowOverlay(false);
        m_effect = DROPEFFECT_NONE;
        m_hasFiles = false;
        m_hasText = false;
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE Drop(IDataObject* data, DWORD keyState, POINTL point, DWORD* effect) noexcept override {
        UNREFERENCED_PARAMETER(keyState);
        UNREFERENCED_PARAMETER(point);
        ShowOverlay(false);
        if (effect != nullptr) {
            *effect = DROPEFFECT_NONE;
        }
        if (data == nullptr) {
            return S_OK;
        }

        if (m_hasFiles) {
            std::vector<std::wstring> paths;
            if (ReadFileDropPaths(data, paths)) {
                if (effect != nullptr) {
                    *effect = DROPEFFECT_COPY;
                }
                std::wstring line = L"Dropped ";
                line += std::to_wstring(paths.size());
                line += L" file(s), opening ";
                line += paths.front();
                DebugLog(line);
                DropFilePath(paths.front());
            }
        } else if (m_hasText) {
            std::wstring text;
            if (ReadUnicodeText(data, text) && !text.empty()) {
                if (effect != nullptr) {
                    *effect = DROPEFFECT_COPY;
                }
                std::wstring message = L"{\"type\":\"insertText\",\"text\":\"";
                message += JsonEscape(text);
                message += L"\"}";
                SendToWeb(message);
            }
        }
        m_hasFiles = false;
        m_hasText = false;
        m_effect = DROPEFFECT_NONE;
        return S_OK;
    }

private:
    static void ShowOverlay(bool visible) {
        if (g_app.dropOverlayVisible == visible) {
            return;
        }
        g_app.dropOverlayVisible = visible;
        RunScriptInWeb(visible
                           ? L"window.__justviewmdDragOverlay && window.__justviewmdDragOverlay(true);"
                           : L"window.__justviewmdDragOverlay && window.__justviewmdDragOverlay(false);");
    }

    bool m_hasFiles = false;
    bool m_hasText = false;
    DWORD m_effect = DROPEFFECT_NONE;
};

// The WebView2 renders into child windows of its own: Chrome_WidgetWin_0 (the
// controller's window, created in this process), Chrome_WidgetWin_1 and
// Chrome_RenderWidgetHostHWND (both in the WebView2 browser process), plus the
// Intermediate D3D Window when the GPU process paints.  A drop is delivered to
// the window under the cursor, and OLE does not climb to that window's parent,
// so a target on the main window alone only ever sees drops on the frame.
//
// AllowExternalDrop is off (see SetupWebViewAfterControllerCreated), which stops
// the WebView2 from claiming drops for itself, so the same target is registered
// on every child window as well.  A file dropped anywhere in the window, preview
// included, then comes back to the host and opens in a tab instead of navigating
// the embedded browser to it.
void RegisterWebViewDropTargets() {
    if (g_app.dropTarget == nullptr || g_app.window == nullptr) {
        return;
    }

    // Windows are re-created by the WebView2 (a renderer restart, a reload), so
    // handles that have died since the last pass are dropped from the list.
    g_app.webViewDropWindows.erase(
        std::remove_if(g_app.webViewDropWindows.begin(), g_app.webViewDropWindows.end(),
                       [](HWND hwnd) { return ::IsWindow(hwnd) == FALSE; }),
        g_app.webViewDropWindows.end());

    std::vector<HWND> children;
    ::EnumChildWindows(
        g_app.window,
        [](HWND child, LPARAM context) -> BOOL {
            reinterpret_cast<std::vector<HWND>*>(context)->push_back(child);
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&children));

    for (HWND child : children) {
        if (std::find(g_app.webViewDropWindows.begin(), g_app.webViewDropWindows.end(), child) !=
            g_app.webViewDropWindows.end()) {
            continue;
        }
        const HRESULT result = ::RegisterDragDrop(child, g_app.dropTarget);
        if (SUCCEEDED(result)) {
            g_app.webViewDropWindows.push_back(child);
            DebugLog(L"Registered the drop target on a WebView2 child window");
        } else if (result == DRAGDROP_E_ALREADYREGISTERED) {
            DebugLog(L"The WebView2 already registered a drop target on a child window");
        } else {
            DebugLog(L"RegisterDragDrop on a WebView2 child window failed");
        }
    }
}

// ===========================================================================
//  15. Window procedure
// ===========================================================================

// Title bar, border and the colour the WebView2 control paints before the page
// has drawn anything: all three follow the light/dark option.  The caption and
// border colours are Windows 11 attributes; Windows 10 only understands the
// immersive dark-mode flag, which it applies the next time it lays out the
// frame - see the nudge below.
void ApplyWindowTheme() {
    const BOOL dark = g_app.darkMode ? TRUE : FALSE;
    if (FAILED(::DwmSetWindowAttribute(g_app.window, kDwmwaImmersiveDarkMode, &dark, sizeof(dark)))) {
        (void)::DwmSetWindowAttribute(g_app.window, kDwmwaImmersiveDarkModeLegacy, &dark, sizeof(dark));
    }
    const COLORREF caption = g_app.darkMode ? kDarkWindowColor : kLightWindowColor;
    (void)::DwmSetWindowAttribute(g_app.window, kDwmwaCaptionColor, &caption, sizeof(caption));
    (void)::DwmSetWindowAttribute(g_app.window, kDwmwaBorderColor, &caption, sizeof(caption));

    // The frame colours above are only read when the window lays its frame out
    // again, so a live switch would otherwise keep the old title bar until the
    // window is next activated. Bounce the non-client activation state, ending
    // on the real one, to force that layout. (Same-state messages are ignored,
    // hence the detour; plain RedrawWindow has no effect on this.)
    const BOOL active = (::GetActiveWindow() == g_app.window) ? TRUE : FALSE;
    (void)::SendMessageW(g_app.window, WM_NCACTIVATE, FALSE, 0);
    (void)::SendMessageW(g_app.window, WM_NCACTIVATE, TRUE, 0);
    if (!active) {
        (void)::SendMessageW(g_app.window, WM_NCACTIVATE, FALSE, 0);
    }

    if (g_app.controller) {
        ComPtr<ICoreWebView2Controller2> controller2;
        if (SUCCEEDED(g_app.controller->QueryInterface(
                IID_ICoreWebView2Controller2, reinterpret_cast<void**>(controller2.Put())))) {
            COREWEBVIEW2_COLOR color{};
            color.A = 255;
            if (g_app.darkMode) {
                color.R = GetRValue(kDarkWindowColor);
                color.G = GetGValue(kDarkWindowColor);
                color.B = GetBValue(kDarkWindowColor);
            } else {
                color.R = 255;
                color.G = 255;
                color.B = 255;
            }
            (void)controller2->put_DefaultBackgroundColor(color);
        }
    }
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_CREATE:
        g_app.window = window;
        ::DragAcceptFiles(window, TRUE);
        if (g_app.dropTarget == nullptr) {
            auto* dropTarget = new DocumentDropTarget();
            if (SUCCEEDED(::RegisterDragDrop(window, dropTarget))) {
                g_app.dropTarget = dropTarget;  // keep one reference of our own
                DebugLog(L"Registered the drop target on the main window");
            } else {
                dropTarget->Release();
                DebugLog(L"RegisterDragDrop failed; drops rely on WM_DROPFILES");
            }
        }
        return 0;

    case WM_SIZE:
        if (g_app.controller && wParam != SIZE_MINIMIZED) {
            RECT bounds{};
            ::GetClientRect(window, &bounds);
            (void)g_app.controller->put_Bounds(bounds);
        }
        return 0;

    case WM_DPICHANGED: {
        const auto* suggested = reinterpret_cast<const RECT*>(lParam);
        ::SetWindowPos(window, nullptr, suggested->left, suggested->top,
                       suggested->right - suggested->left, suggested->bottom - suggested->top,
                       SWP_NOZORDER | SWP_NOACTIVATE);
        if (g_app.controller) {
            // put_RasterizationScale lives on ICoreWebView2Controller3, which is
            // absent on older runtimes; without it WebView2 still tracks the
            // monitor DPI on its own, so a missing interface is not fatal.
            ComPtr<ICoreWebView2Controller3> controller3;
            if (SUCCEEDED(g_app.controller->QueryInterface(IID_ICoreWebView2Controller3,
                                                           reinterpret_cast<void**>(controller3.Put())))) {
                (void)controller3->put_RasterizationScale(static_cast<double>(HIWORD(wParam)) / 96.0);
            }
        }
        return 0;
    }

    case WM_SETFOCUS:
        if (g_app.controller) {
            (void)g_app.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
        return 0;

    case WM_GETMINMAXINFO: {
        auto* info = reinterpret_cast<MINMAXINFO*>(lParam);
        UINT dpi = ::GetDpiForWindow(window);
        if (dpi == 0) {
            dpi = 96;
        }
        info->ptMinTrackSize.x = ::MulDiv(kMinWindowWidth, static_cast<int>(dpi), 96);
        info->ptMinTrackSize.y = ::MulDiv(kMinWindowHeight, static_cast<int>(dpi), 96);
        return 0;
    }

    case WM_TIMER:
        if (wParam == kTimerCloseFallback && !g_app.pendingContentReason.empty()) {
            ::KillTimer(window, kTimerCloseFallback);
            const std::wstring reason = g_app.pendingContentReason;
            g_app.pendingContentReason.clear();
            g_app.pendingContentCount = 0;
            DebugLog(L"Content fallback: the page did not answer in time");
            if (reason == L"close" && ConfirmAllDirtyTabs(-1)) {
                FinishClose();
            }
        }
        return 0;

    case kImageDownloadedMessage: {
        // A download thread is done and has handed its result over.
        auto* result = reinterpret_cast<ImageDownloadResult*>(lParam);
        if (result != nullptr) {
            ImageDownloadFinished(*result);
            delete result;
        }
        return 0;
    }

    case kUpdateCheckedMessage: {
        // The update check is done and has handed its result over.
        auto* result = reinterpret_cast<UpdateCheckResult*>(lParam);
        if (result != nullptr) {
            UpdateCheckFinished(*result);
            delete result;
        }
        return 0;
    }

    case WM_DROPFILES: {
        const HDROP drop = reinterpret_cast<HDROP>(wParam);
        const UINT count = ::DragQueryFileW(drop, 0xFFFFFFFFu, nullptr, 0);
        if (count > 0) {
            const UINT length = ::DragQueryFileW(drop, 0, nullptr, 0);
            if (length > 0) {
                std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1, L'\0');
                if (::DragQueryFileW(drop, 0, buffer.data(), length + 1) == length) {
                    DropFilePath(std::wstring(buffer.data()));
                }
            }
        }
        ::DragFinish(drop);
        return 0;
    }

    case WM_CLOSE:
        HandleCloseRequest();
        return 0;

    case WM_DESTROY:
        ::KillTimer(window, kTimerCloseFallback);
        ::DragAcceptFiles(window, FALSE);
        if (g_app.dropTarget != nullptr) {
            ::RevokeDragDrop(window);
            for (HWND child : g_app.webViewDropWindows) {
                (void)::RevokeDragDrop(child);
            }
            g_app.webViewDropWindows.clear();
            g_app.dropTarget->Release();
            g_app.dropTarget = nullptr;
        }
        if (g_app.controller) {
            (void)g_app.controller->Close();
            g_app.controller.Reset();
        }
        g_app.webview.Reset();
        g_app.environment.Reset();
        ::PostQuitMessage(0);
        return 0;

    default:
        break;
    }
    return ::DefWindowProcW(window, message, wParam, lParam);
}

// ===========================================================================
//  16. Entry point
// ===========================================================================

void ShowUsage() {
    std::wstring text = L"JustViewMD ";
    text += kAppVersion;
    text += L" - Markdown live preview (offline)\n"
        L"\n"
        L"Usage:\n"
        L"  JustViewMD.exe [options] [document.md]\n"
        L"\n"
        L"Options:\n"
        L"  --register      Add \"Open with JustViewMD\" to the Explorer context menu\n"
        L"  --unregister    Remove the context menu entries and the file associations\n"
        L"  --no-register   Do not add the context menu entries on first run\n"
        L"  --log [file]    Write a diagnostic log (default: %LOCALAPPDATA%\\JustViewMD)\n"
        L"  --assets <dir>  Use a different assets folder (development)\n"
        L"  --devtools      Open the WebView2 developer tools at startup\n"
        L"  --help          Show this message\n"
        L"\n"
        L"Settings and session: %LOCALAPPDATA%\\JustViewMD\\settings.ini\n"
        L"                      (checkForUpdate=0 stops the start-up update check)\n"
        L"Front end:            %LOCALAPPDATA%\\JustViewMD\\assets\\<version>\n"
        L"Online image cache:   %LOCALAPPDATA%\\JustViewMD\\cache\n"
        L"                      (the Options menu shows its size and opens it)\n";
    ::MessageBoxW(nullptr, text.c_str(), kAppName, MB_OK | MB_ICONINFORMATION);
}

int RunApplication(HINSTANCE instance, int showCommand) {
    if (FAILED(::OleInitialize(nullptr))) {
        ShowErrorBox(nullptr, L"JustViewMD could not initialise OLE.");
        return 2;
    }

    if (!FileExists(JoinPath(g_app.assetsDirectory, L"index.html"))) {
        std::wstring message = L"JustViewMD cannot find its front end:\n\n";
        message += JoinPath(g_app.assetsDirectory, L"index.html");
        message += L"\n\nWhen --assets is used, that folder has to contain index.html.";
        ShowErrorBox(nullptr, message);
        ::OleUninitialize();
        return 3;
    }

    (void)EnsureDirectory(g_app.userDataDirectory);
    (void)EnsureDirectory(g_app.imageCacheDirectory);

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = WindowProc;
    windowClass.hInstance = instance;
    windowClass.hIcon = static_cast<HICON>(
        ::LoadImageW(instance, MAKEINTRESOURCEW(IDI_APPICON), IMAGE_ICON, 0, 0, LR_DEFAULTSIZE | LR_SHARED));
    windowClass.hIconSm = static_cast<HICON>(
        ::LoadImageW(instance, MAKEINTRESOURCEW(IDI_APPICON), IMAGE_ICON, 16, 16, LR_SHARED));
    windowClass.hCursor = ::LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = ::CreateSolidBrush(g_app.darkMode ? kDarkWindowColor : kLightWindowColor);
    windowClass.lpszClassName = kWindowClass;
    windowClass.lpszMenuName = nullptr;

    if (::RegisterClassExW(&windowClass) == 0) {
        ShowErrorBox(nullptr, L"JustViewMD could not register its window class.");
        ::OleUninitialize();
        return 4;
    }

    RECT workArea{};
    if (!::SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0)) {
        workArea = RECT{ 0, 0, 1280, 800 };
    }
    const int workWidth = workArea.right - workArea.left;
    const int workHeight = workArea.bottom - workArea.top;
    const int width = std::min(kDefaultWindowWidth, std::max(kMinWindowWidth, workWidth - 80));
    const int height = std::min(kDefaultWindowHeight, std::max(kMinWindowHeight, workHeight - 80));
    const int positionX = workArea.left + (workWidth - width) / 2;
    const int positionY = workArea.top + (workHeight - height) / 2;

    HWND window = ::CreateWindowExW(0, kWindowClass, kAppName, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                                    positionX, positionY, width, height, nullptr, nullptr, instance, &g_app);
    if (window == nullptr) {
        ShowErrorBox(nullptr, L"JustViewMD could not create its window.");
        ::OleUninitialize();
        return 5;
    }

    ApplyWindowTheme();
    ::ShowWindow(window, (showCommand == 0) ? SW_SHOW : showCommand);
    ::UpdateWindow(window);

    if (StartWebViewEngine()) {
        MSG message{};
        int status = 0;
        for (;;) {
            const BOOL result = ::GetMessageW(&message, nullptr, 0, 0);
            if (result == 0) {
                status = static_cast<int>(message.wParam);
                DebugLog(L"Message loop ended, exit code " + std::to_wstring(status));
                break;
            }
            if (result == -1) {
                status = 6;
                DebugLog(L"GetMessage failed: " + HexValue(static_cast<HRESULT>(::GetLastError())));
                break;
            }
            ::TranslateMessage(&message);
            ::DispatchMessageW(&message);
        }
        ::DeleteObject(windowClass.hbrBackground);
        ::UnregisterClassW(kWindowClass, instance);
        ::OleUninitialize();
        return status;
    }

    ::DeleteObject(windowClass.hbrBackground);
    ::UnregisterClassW(kWindowClass, instance);
    ::OleUninitialize();
    return 6;
}

}  // namespace

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE previousInstance, _In_ LPWSTR commandLine,
                      _In_ int showCommand) {
    UNREFERENCED_PARAMETER(previousInstance);
    UNREFERENCED_PARAMETER(commandLine);  // CommandLineToArgvW reads the real one

    (void)::SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    bool wantRegister = false;
    bool wantUnregister = false;
    bool skipAutoRegister = false;
    bool wantHelp = false;
    std::wstring fileToOpen;
    std::wstring assetsOverride;

    g_app.instance = instance;
    g_app.devToolsEnabled = false;

    int argumentCount = 0;
    LPWSTR* arguments = ::CommandLineToArgvW(::GetCommandLineW(), &argumentCount);
    if (arguments != nullptr) {
        for (int index = 1; index < argumentCount; ++index) {
            const std::wstring_view argument(arguments[index]);
            if (argument == L"--register") {
                wantRegister = true;
            } else if (argument == L"--unregister") {
                wantUnregister = true;
            } else if (argument == L"--no-register") {
                skipAutoRegister = true;
            } else if (argument == L"--log") {
                if (index + 1 < argumentCount && arguments[index + 1][0] != L'-') {
                    g_logPath.assign(arguments[++index]);
                } else {
                    g_logPath = JoinPath(JoinPath(LocalAppDataDirectory(), kAppName),
                                         L"justviewmd.log");
                }
            } else if (argument == L"--devtools") {
                g_app.devToolsEnabled = true;
            } else if (argument == L"--help" || argument == L"-h" || argument == L"/?") {
                wantHelp = true;
            } else if (argument == L"--assets") {
                if (index + 1 < argumentCount) {
                    assetsOverride.assign(arguments[++index]);
                } else {
                    wantHelp = true;
                }
            } else if (argument.size() > 1 && argument[0] == L'-' && !FileExists(std::wstring(argument))) {
                wantHelp = true;  // unknown switch
            } else if (fileToOpen.empty()) {
                fileToOpen.assign(argument);
            }
        }
        // Logged while the argument vector is still alive.
        std::wstring summary = L"Arguments:";
        for (int index = 1; index < argumentCount; ++index) {
            summary += L" [";
            summary += arguments[index];
            summary += L"]";
        }
        DebugLog(summary);
        ::LocalFree(arguments);
    }

    if (wantHelp) {
        ShowUsage();
        return 0;
    }

    if (wantRegister || wantUnregister) {
        if (wantUnregister) {
            // Everything this application can register, so that "unregister"
            // really leaves Windows the way it was found.
            const bool menus = UnregisterShellIntegration();
            const bool defaults = UnregisterDefaultApplication();
            return (menus && defaults) ? 0 : 1;
        }
        const bool ok = RegisterShellIntegration(false);
        return ok ? 0 : 1;
    }

    if (!assetsOverride.empty()) {
        // Development: serve exactly the folder that was asked for.
        g_app.assetsDirectory = assetsOverride;
    } else {
        g_app.assetsDirectory = PrepareEmbeddedAssets();
        if (g_app.assetsDirectory.empty()) {
            // Unpacking can only fail for reasons outside the program (a full
            // disk, a read-only profile).  A folder beside the executable is
            // the last resort before giving up.
            const std::wstring beside = JoinPath(DirectoryOf(ExePath()), kAssetsFolder);
            if (FileExists(JoinPath(beside, L"index.html"))) {
                g_app.assetsDirectory = beside;
            } else {
                std::wstring message = L"JustViewMD could not unpack its front end into\n\n";
                message += EmbeddedAssetsDirectory();
                message += L"\n\nRun it with --log to see the reason.";
                ShowErrorBox(nullptr, message);
                return 3;
            }
        }
    }
    DebugLog(L"JustViewMD " + std::wstring(kAppVersion));
    DebugLog(L"Front end: " + g_app.assetsDirectory);
    g_app.userDataDirectory = JoinPath(JoinPath(LocalAppDataDirectory(), kAppName), L"WebView2");
    g_app.imageCacheDirectory = JoinPath(JoinPath(LocalAppDataDirectory(), kAppName), kImageCacheFolder);
    g_app.pendingOpenPath = fileToOpen;
    if (!fileToOpen.empty()) {
        g_lastDirectory = DirectoryOf(fileToOpen);
    }

    // The options decide the window colours and the first paint of the WebView,
    // so they have to be known before anything is created.
    LoadOptions();

    // First run: make right-clicking a .md file in Explorer work out of the box.
    if (!skipAutoRegister && !IsShellIntegrationRegistered()) {
        (void)RegisterShellIntegration(true);
    }

    return RunApplication(instance, showCommand);
}
