# Install LINE Agent MCP on Windows

[Project home](../README.md) · [Features](features.md) · [Upgrade and rollback](MIGRATING.md)

This guide installs **LINE Agent MCP v3.3.9** from the maintained
[bensonmaxai/line-desktop-mcp](https://github.com/bensonmaxai/line-desktop-mcp)
repository. The display name is LINE Agent MCP; the package and MCP server name
remain `line-desktop-mcp`.

Examples use `C:\Tools`. Use an equivalent local, user-owned directory if that
path does not suit your machine. Keep the checkout, virtual environment,
downloaded archives, and extracted binaries outside OneDrive.

Obtain this release from its GitHub tag and the attached
`line-desktop-mcp-3.3.9.tgz` with `SHA256SUMS.txt`. Verify the archive against the published checksum before use. It is **not** published to the npm registry and
does not provide an MCPB bundle. Do not install `line-desktop-mcp@latest` from
npm: it is not this release.

The [v3.3.9 GitHub release](https://github.com/bensonmaxai/line-desktop-mcp/releases/tag/v3.3.9) provides the archive and checksum file. Compare the archive's `Get-FileHash -Algorithm SHA256` result with its entry in `SHA256SUMS.txt`.

## Requirements

| What you want to use | Requirement |
| --- | --- |
| Base MCP server | Node.js 24 LTS or newer. The package requires Node >= 24.0.0; v3.3.9 pins @modelcontextprotocol/sdk 1.29.0. |
| Windows extension catalogue | Set `LINE_MCP_EXTENSIONS=1`. This lists 35 active Windows tools; five legacy aliases remain callable but hidden (40 implemented descriptors). Without that exact value, five default descriptors remain. macOS also lists those five defaults. |
| Local text and media context | Windows x64, a signed-in LINE Desktop process whose build is in the shipped allowlist, a 64-bit Python, both required Python packages, and the pinned SQLite3MC DLL described below. LINE Desktop 26.6.0.4004 was tested for this release. |
| Named-chat GUI tools | Every Windows named-chat GUI path, including the five defaults, requires a separately installed CUA Driver plus the local-reader Python/DLL prerequisites. AutoHotkey v2 is required only by legacy GUI helper paths; local Windows OCR is required only when the selected path uses it. |

The reader refuses an unknown LINE build with `LINE_BUILD_UNVERIFIED`; it does
not attempt to guess compatibility. A signed-in LINE process is required for
local reading, but this guide does not automate LINE sign-in.

The server is local **stdio only**. It has no HTTP or REST endpoint, and
command-line options are rejected before server startup. It does not
automatically load a `.env` file from the current directory: put every setting
in your MCP client's server environment.

## 1. Check out the exact release and install Node dependencies

Choose an empty local directory. Do not clone over an existing installation;
the [upgrade guide](MIGRATING.md) uses a sibling checkout so rollback stays
available.

~~~powershell
git clone --branch v3.3.9 --depth 1 https://github.com/bensonmaxai/line-desktop-mcp.git C:\Tools\line-desktop-mcp-v3.3.9
Set-Location C:\Tools\line-desktop-mcp-v3.3.9
git describe --exact-match --tags
npm ci --ignore-scripts
~~~

`git describe` should print `v3.3.9`. The lockfile is included, so use
`npm ci --ignore-scripts`, not an unpinned registry install. `--ignore-scripts`
keeps package lifecycle scripts from running during installation.

Confirm that the Node executable selected by your MCP client is version 24 or
newer:

~~~powershell
node --version
node -p "process.versions.node"
~~~

## 2. Prepare the local reader

The local reader creates bounded, read-only copies of the relevant LINE
database and WAL data. It is not a full account archive or a migration tool.
Even `mediaMode: "metadata"` requires both Python packages because the reader
imports `cryptography` and Pillow before selecting a media mode.

### 2.1 Create a 64-bit Python virtual environment

Install 64-bit Python separately, then use its absolute executable to make a
venv outside OneDrive. Python 3.12.14 was tested. Substitute your real
absolute Python path below.

~~~powershell
$basePython = 'C:\Tools\Python312\python.exe'
$venv = 'C:\Tools\line-desktop-mcp-v3.3.9\.venv'
& $basePython -m venv $venv
$readerPython = Join-Path $venv 'Scripts\python.exe'
& $readerPython -m pip install -r C:\Tools\line-desktop-mcp-v3.3.9\src\extensions\python\requirements.txt
& $readerPython -c "import platform, cryptography, PIL; print(platform.architecture()[0], cryptography.__version__, PIL.__version__)"
~~~

The requirements are `cryptography>=43.0.0` and `Pillow>=10.0.0`. The tested
versions were cryptography 50.0.1 and Pillow 12.3.0. The final command should
report a 64-bit architecture and both installed versions.

### 2.2 Download and verify the SQLite3MC DLL

The reader requires exactly the 64-bit SQLite3MultipleCiphers DLL below. It
will independently verify the DLL hash each time it is used; do not bypass a
hash mismatch or substitute another SQLite build.

Download the archive manually from the
[official SQLite3MultipleCiphers v2.5.1 release](https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v2.5.1/sqlite3mc-2.5.1-sqlite-3.53.4-win64.zip),
or use this explicit PowerShell sequence in an empty local runtime directory:

~~~powershell
$runtimeRoot = 'C:\Tools\line-desktop-mcp-runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$sqliteArchive = Join-Path $runtimeRoot 'sqlite3mc-2.5.1-sqlite-3.53.4-win64.zip'
Invoke-WebRequest -Uri 'https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v2.5.1/sqlite3mc-2.5.1-sqlite-3.53.4-win64.zip' -OutFile $sqliteArchive
$expectedArchiveHash = '858c4f2e9e262caca06e6c4fafee62d13dd90c21b649b047f17992bf0402981e'
$actualArchiveHash = (Get-FileHash -LiteralPath $sqliteArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualArchiveHash -ne $expectedArchiveHash) { throw 'SQLite3MC archive SHA-256 mismatch.' }

$sqliteRoot = Join-Path $runtimeRoot 'sqlite3mc-2.5.1'
Expand-Archive -LiteralPath $sqliteArchive -DestinationPath $sqliteRoot
$sqliteDll = Join-Path $sqliteRoot 'dll\sqlite3mc_x64.dll'
$expectedDllHash = '5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e'
$actualDllHash = (Get-FileHash -LiteralPath $sqliteDll -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualDllHash -ne $expectedDllHash) { throw 'SQLite3MC DLL SHA-256 mismatch.' }
$sqliteDll
~~~

The last line must print the full path to `sqlite3mc_x64.dll`. Keep that path
for `LINE_MCP_SQLITE3MC_DLL`; it must be an absolute `.dll` path.

## 3. Named-chat GUI prerequisites

Pure local database reading works without the CUA Driver. In v3.3.9, however,
every Windows GUI operation scoped to a named chat—including each of the five
default descriptors—requires `LINE_MCP_CUA_DRIVER`, `LINE_MCP_PYTHON`, and the
pinned `LINE_MCP_SQLITE3MC_DLL`. This project does not install those components,
change PATH, or run a persistent service. An unavailable prerequisite refuses
the GUI operation; it does not silently use a less-verified compatibility path.

Before a CUA LINE-window listing/state read/input or any AutoHotkey/clipboard
activity, a private fresh metadata-only lookup must resolve one complete, unique
identity: an exact raw group name or an exact effective contact name with an
existing direct-chat row. It reads no message rows or media. NFC-equivalent
spellings, trimmed or collapsed whitespace, and group member-count suffixes are
not aliases. A contact-name collision refuses even if a competing contact has
no chat row. Missing, ambiguous, incomplete, or cross-type matches fail closed.
CUA connection and tool negotiation may occur before this identity gate.

The exact unbound `Keep筆記` open request uses the verified self profile and existing direct-chat row, checks for colliding names, and follows the built-in shortcut. Its title verification supplies no chat reference or send proof.

`open_line_chat` resolves the exact chat and may open or reuse its titled
window; it verifies the final HWND, PID, title and chat header. A first search
result alone is never identity proof. The active-chat guard checks before input
and after it completes, and plain-text send refreshes identity immediately
before Return. If the bridge cannot maintain identity certainty, it refuses
without automatically continuing or retrying. Snapshot uniqueness plus
a fresh UI header is not an atomic database-ID-to-UI mapping, so wait for LINE to
settle after a concurrent rename or chat creation before retrying.

Tool/capability metadata remains callable without chat-identity proof, and
`get_line_status` preserves independent local-reader status when GUI status is
unavailable. Pure local DB history retains its reader prerequisites but needs no
CUA; the poll reader retains its established local-group identity and CUA
requirements. macOS still lists five descriptors, but legacy reads and sends
return `LINE_CHAT_VERIFICATION_UNAVAILABLE` before automation or clipboard
activity because it has no verified local active-chat reader.

Legacy history accepts only clipboard text owned by the bound LINE process. The
helper restores the prior available clipboard formats only while its owned
sequence is unchanged. A foreign update is preserved and the history read
refuses. Clipboard History or listeners may still retain the transient copy, and
a small compare/restore race remains. See [v3 upgrade and compatibility
notes](MIGRATING.md#upgrading-to-v300).

### CUA Driver 0.46.1

Download the
[official CUA Driver 0.46.1 Windows x86_64 archive](https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.46.1/cua-driver-rs-0.46.1-windows-x86_64-binary.zip)
and verify its archive hash before extracting it:

~~~powershell
$runtimeRoot = 'C:\Tools\line-desktop-mcp-runtime'
$driverArchive = Join-Path $runtimeRoot 'cua-driver-rs-0.46.1-windows-x86_64-binary.zip'
Invoke-WebRequest -Uri 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.46.1/cua-driver-rs-0.46.1-windows-x86_64-binary.zip' -OutFile $driverArchive
$expectedDriverArchiveHash = 'ec49cca509f25f65db2fa917718215f55f959d5ef650bf8ab2238a201d5666ac'
$actualDriverArchiveHash = (Get-FileHash -LiteralPath $driverArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualDriverArchiveHash -ne $expectedDriverArchiveHash) { throw 'CUA Driver archive SHA-256 mismatch.' }

$driverRoot = Join-Path $runtimeRoot 'cua-driver-rs-0.46.1'
Expand-Archive -LiteralPath $driverArchive -DestinationPath $driverRoot
Get-ChildItem -LiteralPath $driverRoot -Recurse -File -Filter '*.exe' | Select-Object FullName
~~~

Use the extracted driver's absolute `.exe` path for `LINE_MCP_CUA_DRIVER`.
For each UI operation, LINE Agent MCP starts that public executable with
`mcp --direct` over stdio and closes the session afterward. It does not run an
always-on daemon.

### AutoHotkey v2 and local OCR

Install AutoHotkey v2 separately if you need the legacy GUI helper paths. A
standard installation is used at:

~~~text
C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe
~~~

For a nonstandard installation, set `LINE_MCP_AUTOHOTKEY` to an absolute
AutoHotkey v2 `.exe` path. The helper does not look on PATH or in the current
directory: it runs the resolved executable with `shell: false`. Its process
check also uses the absolute `%SystemRoot%\System32\tasklist.exe` path. These
executables are checked only at the GUI-operation boundary, so metadata and
capability calls do not install or require them.

Windows OCR is local and used only by paths that request it. Its availability
depends on the installed Windows language/OCR components; no cloud OCR is
implied.

## 4. Configure one local stdio MCP server

Keep the MCP server name as `line-desktop-mcp`. Replace every example path with
an existing absolute path on your computer. This generic configuration shows
the complete Windows extension setup:

~~~json
{
  "mcpServers": {
    "line-desktop-mcp": {
      "command": "C:/Tools/node/node.exe",
      "args": [
        "C:/Tools/line-desktop-mcp-v3.3.9/src/server.js"
      ],
      "env": {
        "LINE_MCP_EXTENSIONS": "1",
        "LINE_MCP_PYTHON": "C:/Tools/line-desktop-mcp-v3.3.9/.venv/Scripts/python.exe",
        "LINE_MCP_SQLITE3MC_DLL": "C:/Tools/line-desktop-mcp-runtime/sqlite3mc-2.5.1/dll/sqlite3mc_x64.dll",
        "LINE_MCP_CUA_DRIVER": "C:/Tools/line-desktop-mcp-runtime/cua-driver-rs-0.46.1/cua-driver.exe",
        "LINE_MCP_AUTOHOTKEY": "C:/Program Files/AutoHotkey/v2/AutoHotkey64.exe"
      }
    }
  }
}
~~~

The CUA Driver filename above is illustrative: use the exact `.exe` path
printed by the extraction command. The standard AutoHotkey path is already the
default; including it makes the sample explicit. Set
`LINE_MCP_AUTOHOTKEY` only to override a nonstandard installation.

For a new Codex registration, the same values can be supplied with quoted
PowerShell arguments:

~~~powershell
codex mcp add line-desktop-mcp --env "LINE_MCP_EXTENSIONS=1" --env "LINE_MCP_PYTHON=C:/Tools/line-desktop-mcp-v3.3.9/.venv/Scripts/python.exe" --env "LINE_MCP_SQLITE3MC_DLL=C:/Tools/line-desktop-mcp-runtime/sqlite3mc-2.5.1/dll/sqlite3mc_x64.dll" --env "LINE_MCP_CUA_DRIVER=C:/Tools/line-desktop-mcp-runtime/cua-driver-rs-0.46.1/cua-driver.exe" --env "LINE_MCP_AUTOHOTKEY=C:/Program Files/AutoHotkey/v2/AutoHotkey64.exe" -- "C:\Tools\node\node.exe" "C:\Tools\line-desktop-mcp-v3.3.9\src\server.js"
~~~

If you only want the five default descriptors, omit `LINE_MCP_EXTENSIONS`
entirely and reconnect the MCP client. Their names, order, and input schemas
remain, but that does not bypass the v3 named-chat GUI identity gate. With
extensions enabled, leave the reader paths configured for local context and the
CUA/AHK paths configured for GUI work; each affected operation reports its own
unavailable prerequisite rather than silently taking another route.

## 5. Reconnect and verify without reading a chat

Restart or reconnect your MCP client after changing its server configuration so
it refreshes the schema. The first safe call is:

~~~text
get_line_capabilities({})
~~~

On Windows with `LINE_MCP_EXTENSIONS=1`, expect `toolCount: 26`. This call
lists bridge capabilities only; it does not read a chat, inspect media, operate
LINE, or send anything.

You can also call:

~~~text
get_line_status({})
~~~

This checks LINE build and process metadata without reading a chat or scanning
memory. Its `localReader` field is **not** a full Python, package, DLL, or
database-readiness test. A successful status response therefore does not
replace the dependency checks above.

For a synthetic local verification after setup:

~~~powershell
Set-Location C:\Tools\line-desktop-mcp-v3.3.9
$env:LINE_MCP_PYTHON = 'C:\Tools\line-desktop-mcp-v3.3.9\.venv\Scripts\python.exe'
$env:LINE_MCP_SQLITE3MC_DLL = 'C:\Tools\line-desktop-mcp-runtime\sqlite3mc-2.5.1\dll\sqlite3mc_x64.dll'
npm test
npm run test:python
~~~

The included runners use sanitized synthetic fixtures and do not read real
chats or send LINE messages. Python tests require the configured reader
environment. v3.0.1 verification recorded 234 passing Node tests and 124 passing
Python tests with one existing file-symlink privilege skip (125 total), including
all native SQLite3MC checks. Historical v3.0.0 security verification recorded
221/221 Node checks, 101 passing
Python checks plus one symlink-related skip (102 total), nine native SQLite
checks, and an AutoHotkey parser pass. Those figures are historical v3.0.x
evidence. v3.2.0 live checks covered dated MCP read/search/verify and
one-record TXT/JSON/CSV exports; guided UI checks cover the rich features
listed in the [v3.2.0 notes](releases/v3.2.0.en.md). See [v3.3.0 notes](releases/v3.3.0.en.md) for recipient and forwarding checks, and [v3.3.1 notes](releases/v3.3.1.en.md) for group preparation, and [v3.3.2 notes](releases/v3.3.2.en.md) for search and window checks, plus [v3.3.3 notes](releases/v3.3.3.en.md) for recent group discovery, and [v3.3.4 notes](releases/v3.3.4.en.md) for single-direct category OCR, and [v3.3.5 notes](releases/v3.3.5.en.md) for mixed-search OCR. None establishes
recipient delivery or read state.

## Large local databases

v3.0.1 removes the fixed 256 MiB source-file cap from the
local reader. The original v3.0.0 release does not support the settings below;
use v3.0.1 or later. Encrypted database and WAL bytes are copied
in bounded chunks to the local request directory; the reader does not load a
whole database into a Python byte buffer. It still scans the complete files
to verify the observed snapshot, so disk speed, source activity, and available
disk space affect completion time.

| MCP client environment setting | Default | Maximum allowed |
| --- | ---: | ---: |
| `LINE_MCP_MAX_SOURCE_BYTES` (database) | 2147483648 (2 GiB) | 8589934592 (8 GiB) |
| `LINE_MCP_MAX_WAL_BYTES` | 268435456 (256 MiB) | 1073741824 (1 GiB) |
| `LINE_MCP_MAX_SNAPSHOT_BYTES` (database + source WAL) | 2415919104 (2304 MiB) | 9663676416 (9 GiB) |
| `LINE_MCP_READER_TIMEOUT_MS` | 300000 (5 minutes) | 1800000 (30 minutes) |

Byte settings must be positive decimal integers. The timeout must be an
integer from 1000 to 1800000 milliseconds. Invalid settings fail explicitly
with `SOURCE_LIMIT_INVALID` or `LOCAL_READER_TIMEOUT_INVALID`; an invalid
value never removes the bound. Set overrides in the MCP client's environment
and reconnect the server, not in tool arguments or an automatically loaded
`.env` file. When raising the database limit, also allow sufficient combined
snapshot capacity. A larger timeout here does not override the AI client's
own request deadline.

`SOURCE_TOO_LARGE` identifies whether the database, WAL, or combined size
exceeded its limit, along with byte counts and the relevant setting name.
Reducing `dateFrom`, `dateTo`, or `messageLimit` only narrows the SQL result;
it does not shrink the encrypted source files. Clearing LINE's media cache
does not change this source-file limit. Deleting chat history is not required
to use the fixed reader.

Keep enough free space for an encrypted DB/WAL copy and SQLite's small
sidecars under the local application runtime directory. `SNAPSHOT_DISK_FULL`
reports exhausted scratch storage. `SOURCE_BUSY` means the source pair did
not remain stable within three attempts; request a new read when the
source is quieter. The reader never forces a checkpoint, VACUUM, or write on
LINE's source database. It validates WAL checksums and the last committed
boundary before querying its private copy.

The child cleans normal request files; its Node parent also waits for child
exit and removes only that request's fixed snapshot files after errors or a
timeout. Cleanup failures are reported, never disguised as a successful read.
If `LOCAL_READER_TERMINATION_FAILED` reports `mayStillBeRunning: true`, child
exit could not be confirmed within a bounded grace period. Its scratch files
are retained until the child actually exits, so cleanup never races a live
writer.
Abrupt termination of the entire MCP server or a system crash can still
leave encrypted scratch files; there is no broad automatic deletion sweep.

Source-checkout maintainers can run the opt-in large encrypted fixture check
separately for each size (requires the configured Python and native DLL):

~~~powershell
& $env:LINE_MCP_PYTHON -B scripts/benchmark-large-reader.py --size-mib 800
& $env:LINE_MCP_PYTHON -B scripts/benchmark-large-reader.py --size-mib 1024
~~~

It creates and removes its own encrypted fixtures, verifies the newest
committed message through the scoped reader, records time and peak memory,
and checks that source hashes and cleanup behavior are correct. It does not
read a real LINE account or scan a LINE process for keys.

## First context request

Name the chat and the date range in the request. Start with the default
metadata mode, which returns text and attachment metadata without GUI actions
or image decoding. For example:

~~~text
Read only the named chat “Project example” from 2026-09-10 through 2026-09-11.
Use the default metadata mode, summarize the text, and do not send or open the
LINE UI.
~~~

If the returned page identifies relevant image `sourceRef` values, make a
second request using `mediaMode: "preview"` and only those refs from that same
page. PNG and JPEG previews are supported; APNG, GIF, and WebP use their first
frame.
Small PCM WAV blocks can be returned, while video, general audio playback,
transcription, and arbitrary file extraction are not features of this bridge.

The MCP supplies preview bytes; an image-capable AI client/model interprets
them. Decoding is local, but using a cloud AI client for interpretation is not
an entirely offline workflow. Missing, unsupported, and response-budget-deferred
cache entries are returned explicitly.

For reads, have the user name the chat and intended bounded scope. For sends
or shared changes, review the exact destination and content in the client and
obtain explicit approval at the action boundary. The reply `sourceToken` is a
short-lived visual source-attestation token, not a general permission token or
send approval.

See [Features](features.md) for behavior and limits, or
[Upgrade and rollback](MIGRATING.md#upgrading-to-v300) when moving from v1.2.0
or v2.0.0.

## Read-only CLI

Run `node src/cli.js --help` or `node src/cli.js capabilities --json`.
Scoped local reads and exports use the same Python/SQLite3MC prerequisites.
See the [CLI guide](CLI.md) for required chat/date scope, pagination and exit codes.
