# ===========================================================================
#  JustViewMD - build configuration
#
#  Requirements:
#    * CMake 3.20 or newer
#    * MSVC (Visual Studio 2019/2022 with the C++ workload) or MinGW-w64
#    * Internet access the first time the project is configured, only to fetch
#      the WebView2 SDK from NuGet.  Configure with
#      -DJVMD_WEBVIEW2_ROOT=<unpacked package>/build/native to avoid that.
#
#  Everything the finished program needs at run time (the Markdown engines,
#  KaTeX fonts, Mermaid, Prism) is vendored in assets/ and compiled into the
#  executable as resources, so the application itself works completely offline.
# ===========================================================================

cmake_minimum_required(VERSION 3.20)

project(JustViewMD VERSION 1.0.3 LANGUAGES CXX)

if (NOT WIN32)
    message(FATAL_ERROR "JustViewMD is a Windows desktop application.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if (NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# ---------------------------------------------------------------------------
#  Microsoft Edge WebView2 SDK
# ---------------------------------------------------------------------------

set(JVMD_WEBVIEW2_VERSION "1.0.4258.31" CACHE STRING
    "Version of the Microsoft.Web.WebView2 NuGet package to use")

set(JVMD_WEBVIEW2_ROOT "" CACHE PATH
    "Unpacked Microsoft.Web.WebView2 package: the folder holding include/ and x64/")

if (NOT JVMD_WEBVIEW2_ROOT)
    set(_jvmd_cache   "${CMAKE_BINARY_DIR}/_deps/webview2")
    set(_jvmd_extract "${_jvmd_cache}/extracted")
    set(_jvmd_nupkg   "${_jvmd_cache}/Microsoft.Web.WebView2.${JVMD_WEBVIEW2_VERSION}.nupkg")

    if (NOT EXISTS "${_jvmd_extract}/build/native/include/WebView2.h")
        if (NOT EXISTS "${_jvmd_nupkg}")
            file(MAKE_DIRECTORY "${_jvmd_cache}")
            set(_jvmd_url "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${JVMD_WEBVIEW2_VERSION}/microsoft.web.webview2.${JVMD_WEBVIEW2_VERSION}.nupkg")
            message(STATUS "Downloading Microsoft.Web.WebView2 ${JVMD_WEBVIEW2_VERSION}")
            file(DOWNLOAD "${_jvmd_url}" "${_jvmd_nupkg}" STATUS _jvmd_status TLS_VERIFY ON SHOW_PROGRESS)

            if (NOT _jvmd_status MATCHES "^0")
                # CMake's bundled libcurl uses its own CA bundle and fails behind
                # TLS-inspecting proxies.  PowerShell uses the Windows store, so
                # it is a reliable second attempt on such machines.
                message(STATUS "cmake -E download failed (${_jvmd_status}); retrying with PowerShell")
                file(REMOVE "${_jvmd_nupkg}")
                find_program(JVMD_POWERSHELL_EXECUTABLE NAMES powershell pwsh
                             DOC "PowerShell used to fetch the WebView2 SDK")
                if (JVMD_POWERSHELL_EXECUTABLE)
                    execute_process(
                        COMMAND "${JVMD_POWERSHELL_EXECUTABLE}" -NoProfile -NonInteractive
                                -ExecutionPolicy Bypass -Command
                                "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${_jvmd_url}' -OutFile '${_jvmd_nupkg}' -UseBasicParsing"
                        RESULT_VARIABLE _jvmd_shell_status
                        OUTPUT_QUIET)
                    if (_jvmd_shell_status EQUAL 0 AND EXISTS "${_jvmd_nupkg}")
                        set(_jvmd_status 0)
                    endif()
                endif()
            endif()

            if (NOT _jvmd_status MATCHES "^0")
                file(REMOVE "${_jvmd_nupkg}")
                message(FATAL_ERROR
                    "Could not download the WebView2 SDK from NuGet.\n"
                    "Download the Microsoft.Web.WebView2 package by hand, unpack it, and configure with\n"
                    "    -DJVMD_WEBVIEW2_ROOT=<unpacked>/build/native")
            endif()
        endif()
        message(STATUS "Unpacking the WebView2 SDK")
        file(ARCHIVE_EXTRACT INPUT "${_jvmd_nupkg}" DESTINATION "${_jvmd_extract}")
    endif()

    set(JVMD_WEBVIEW2_ROOT "${_jvmd_extract}/build/native" CACHE PATH "WebView2 SDK" FORCE)
endif()

if (CMAKE_SYSTEM_PROCESSOR MATCHES "^(ARM64|arm64|aarch64)")
    set(_jvmd_arch "arm64")
elseif (CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(_jvmd_arch "x64")
else()
    set(_jvmd_arch "x86")
endif()

set(_jvmd_include "${JVMD_WEBVIEW2_ROOT}/include")
set(_jvmd_loader  "${JVMD_WEBVIEW2_ROOT}/${_jvmd_arch}")

if (NOT EXISTS "${_jvmd_include}/WebView2.h")
    message(FATAL_ERROR "WebView2.h was not found below ${JVMD_WEBVIEW2_ROOT}.")
endif()

# ---------------------------------------------------------------------------
#  The version, defined in exactly one place
#
#  project(... VERSION ...) above is that place.  The numbers are written out
#  here for the resource script (app.rc includes the header) and for main.cpp,
#  which shows the version in the Options menu and compares it with the
#  releases published on GitHub.  Bumping a release is therefore one edit, and
#  the file version, the menu and the update check cannot drift apart.  The
#  executable is named after the same number, so a file on disk says which
#  release it came from.
# ---------------------------------------------------------------------------

string(CONCAT _jvmd_version_header
    "// Generated by CMake from the version in project().  Do not edit.\n"
    "#ifndef JVMD_VERSION_GENERATED_H\n"
    "#define JVMD_VERSION_GENERATED_H\n"
    "\n"
    "#define JVMD_VERSION_MAJOR ${PROJECT_VERSION_MAJOR}\n"
    "#define JVMD_VERSION_MINOR ${PROJECT_VERSION_MINOR}\n"
    "#define JVMD_VERSION_PATCH ${PROJECT_VERSION_PATCH}\n"
    "#define JVMD_VERSION_COMMA ${PROJECT_VERSION_MAJOR},${PROJECT_VERSION_MINOR},${PROJECT_VERSION_PATCH},0\n"
    "#define JVMD_VERSION_DOTTED \"${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR}.${PROJECT_VERSION_PATCH}.0\"\n"
    "#define JVMD_VERSION_SHORT \"${PROJECT_VERSION}\"\n"
    "#define JVMD_VERSION_SHORT_WIDE L\"${PROJECT_VERSION}\"\n"
    "#define JVMD_VERSION_BINARY \"JustViewMD_v${PROJECT_VERSION}.exe\"\n"
    "#define JVMD_VERSION_BINARY_WIDE L\"JustViewMD_v${PROJECT_VERSION}.exe\"\n"
    "\n"
    "#endif  // JVMD_VERSION_GENERATED_H\n")

file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/version_generated.h" "${_jvmd_version_header}")

# ---------------------------------------------------------------------------
#  The front end, compiled into the executable
#
#  Every file below assets/ becomes an RCDATA resource.  The resource ids and
#  the paths are written to assets_manifest.h, so the unpacking code in
#  main.cpp and the resource script cannot disagree.  All assets are configure
#  dependencies: editing app.js re-runs CMake, which rewrites the .rc, and the
#  resource compiler therefore picks up the new bytes.
# ---------------------------------------------------------------------------

set(_jvmd_assets_root "${CMAKE_CURRENT_SOURCE_DIR}/assets")
file(GLOB_RECURSE _jvmd_assets RELATIVE "${_jvmd_assets_root}" LIST_DIRECTORIES false
     CONFIGURE_DEPENDS "${_jvmd_assets_root}/*")
list(SORT _jvmd_assets)

if (NOT _jvmd_assets)
    message(FATAL_ERROR "The assets folder is empty: ${_jvmd_assets_root}")
endif()

set(_jvmd_asset_files ${_jvmd_assets})
list(TRANSFORM _jvmd_asset_files PREPEND "${_jvmd_assets_root}/")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_jvmd_asset_files})

set(_jvmd_assets_rc "// Generated by CMake from the files below assets/.\n")
string(CONCAT _jvmd_assets_header
    "// Generated by CMake from the files below assets/.\n"
    "#ifndef JVMD_ASSETS_MANIFEST_H\n"
    "#define JVMD_ASSETS_MANIFEST_H\n"
    "\n"
    "#include <cstddef>\n"
    "\n"
    "namespace jvmd_assets {\n"
    "\n"
    "struct Entry {\n"
    "    unsigned id;\n"
    "    const wchar_t* path;\n"
    "};\n"
    "\n"
    "inline constexpr const wchar_t kCacheVersion[] = L\"${PROJECT_VERSION}\";\n"
    "inline constexpr const wchar_t kLoaderVersion[] = L\"${JVMD_WEBVIEW2_VERSION}\";\n"
    "\n"
    "inline constexpr Entry kEntries[] = {\n")

set(_jvmd_asset_id 1000)
foreach(_jvmd_asset IN LISTS _jvmd_assets)
    math(EXPR _jvmd_asset_id "${_jvmd_asset_id} + 1")
    string(APPEND _jvmd_assets_rc "${_jvmd_asset_id} RCDATA \"${_jvmd_assets_root}/${_jvmd_asset}\"\n")
    string(APPEND _jvmd_assets_header "    { ${_jvmd_asset_id}, L\"${_jvmd_asset}\" },\n")
endforeach()

string(APPEND _jvmd_assets_header
    "};\n"
    "\n"
    "inline constexpr std::size_t kEntryCount = sizeof(kEntries) / sizeof(kEntries[0]);\n"
    "\n"
    "}  // namespace jvmd_assets\n"
    "\n"
    "#endif  // JVMD_ASSETS_MANIFEST_H\n")

file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/assets.rc" "${_jvmd_assets_rc}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/assets_manifest.h" "${_jvmd_assets_header}")

# ---------------------------------------------------------------------------
#  Resources (icon, version info and the front end).  No resource compiler
#  means no front end, so that case is an error rather than a silent omission.
# ---------------------------------------------------------------------------

set(_jvmd_sources src/main.cpp)

if (MSVC)
    set(_jvmd_resources src/app.rc "${CMAKE_CURRENT_BINARY_DIR}/assets.rc")
else()
    enable_language(RC OPTIONAL)
    if (NOT CMAKE_RC_COMPILER)
        message(FATAL_ERROR
            "A resource compiler is required: the front end is compiled into the executable.\n"
            "Install windres (MinGW-w64) or the Visual Studio resource compiler.")
    endif()
    # MinGW cannot link the Visual C++ static loader, so the redistributable DLL
    # itself becomes a resource.  main.cpp unpacks it under %LOCALAPPDATA% and
    # loads it by absolute path.  2000 is IDR_WEBVIEW2_LOADER in resource.h.
    set(_jvmd_loader_rc "${CMAKE_CURRENT_BINARY_DIR}/loader.rc")
    file(WRITE "${_jvmd_loader_rc}"
        "// Generated by CMake: WebView2Loader.dll, compiled into the executable.\n"
        "2000 RCDATA \"${_jvmd_loader}/WebView2Loader.dll\"\n")
    set(_jvmd_resources src/app.rc "${CMAKE_CURRENT_BINARY_DIR}/assets.rc" "${_jvmd_loader_rc}")
endif()

# A resource compiler does not know that app.rc pulls in the icons, and the
# generator does not know the version header is rewritten at configure time, so
# without this a rebuilt .ico or a bumped version would silently keep the
# previous bytes inside the exe.
if (_jvmd_resources)
    set_property(SOURCE src/app.rc APPEND PROPERTY OBJECT_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/src/app.ico;${CMAKE_CURRENT_SOURCE_DIR}/src/file-icon.ico;${CMAKE_CURRENT_BINARY_DIR}/version_generated.h")
endif()

# ---------------------------------------------------------------------------
#  Executable
# ---------------------------------------------------------------------------

add_executable(JustViewMD WIN32 ${_jvmd_sources} ${_jvmd_resources})

set_target_properties(JustViewMD PROPERTIES
    OUTPUT_NAME                               "JustViewMD_v${PROJECT_VERSION}"
    RUNTIME_OUTPUT_DIRECTORY                  "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG            "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE          "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO   "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL       "${CMAKE_BINARY_DIR}/bin")

target_include_directories(JustViewMD PRIVATE "${_jvmd_include}" "${CMAKE_CURRENT_BINARY_DIR}")
target_compile_definitions(JustViewMD PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)

if (MSVC)
    # The static loader keeps the distribution to a single executable.
    target_link_libraries(JustViewMD PRIVATE "${_jvmd_loader}/WebView2LoaderStatic.lib")
    target_compile_options(JustViewMD PRIVATE /W4 /permissive- /utf-8)
    if (CMAKE_VERSION VERSION_GREATER_EQUAL 3.15)
        set_property(TARGET JustViewMD PROPERTY MSVC_RUNTIME_LIBRARY
                     "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    endif()
    target_link_options(JustViewMD PRIVATE /OPT:REF /OPT:ICF)
else()
    # MinGW-w64 cannot link WebView2LoaderStatic.lib (it is made by Visual C++
    # and needs that CRT), so WebView2Loader.dll is compiled into the executable
    # and loaded from its unpacked copy instead of being imported.
    target_compile_options(JustViewMD PRIVATE -Wall -Wextra -Wno-unknown-pragmas)
    target_link_options(JustViewMD PRIVATE -municode -static -static-libgcc -static-libstdc++ -s)
endif()

# winhttp is what fetches a picture the document points at; nothing else in the
# application touches the network.
target_link_libraries(JustViewMD PRIVATE
    user32 shell32 ole32 dwmapi comdlg32 shlwapi advapi32 gdi32 winhttp)

message(STATUS "JustViewMD: WebView2 SDK ${JVMD_WEBVIEW2_VERSION} (${_jvmd_arch}) at ${JVMD_WEBVIEW2_ROOT}")
