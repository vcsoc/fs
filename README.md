# fs

**Find what matters.** A local-first CLI and desktop application for searching your drives by meaning, content, filename, dates, and regular expressions.

Developed by **Chris Visser** · [github.com/vcsoc/fs](https://github.com/vcsoc/fs)

## Quick start

Requires Python 3.11+ and Node.js 22.12+ for source execution. Packaged desktop builds include the backend/runtime dependencies. Ollama is optional: fs can run the exact EmbeddingGemma 2 model directly using its built-in ONNX CPU runtime. A mounted drive is selected by choosing its mount directory; fs does not mount or read raw devices.

```sh
uv sync --extra test
npm ci
uv run fs desktop
```

The initial model is exactly **embeddinggemma-2**, automatically managed when adding a semantic location or using Preferences → Set up embedding model.

- The default is **embeddinggemma-2:740m**, running directly inside fs with text, vision, and audio ONNX encoders. No Ollama service is required.
- The setup button applies unsaved model/runtime edits before setup. Its inline bar shows live total download bytes, checksum checks, installation, and real encoder verification; only successful completion reaches Ready / 100%. Queued, failed, and cancelled setup remains distinguishable even if another indexing job starts.
- If an optional Ollama runtime is selected and missing, fs asks permission to install a **private portable Ollama runtime**. No administrator access, shell installer, or system PATH/service changes are required.
- **Yes:** fs downloads a checksum-verified official Ollama release, starts its local service, pulls the selected model, and verifies embeddings.
- **No:** fs downloads EmbeddingGemma 2 directly and runs it inside fs using ONNX Runtime on the CPU, without Ollama.
- If existing Ollama is incompatible (including the Linux MLX-library error), fs automatically prepares that same direct model instead. This is not a substitution with EmbeddingGemma 1.
- Setup, downloads, and indexing run in the background with visible progress and cancellation. Partial direct downloads resume, and artifacts are size/SHA-256 verified before publication.

The full direct distribution uses the **740M Q4 export** of Google’s EmbeddingGemma 2, from `onnx-community/embeddinggemma-2-ONNX`, pinned to revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`. It downloads approximately **505 MB**, including the text backbone/tokenizer plus vision and audio encoders. Existing verified text assets are reused. Every graph and weight artifact has a pinned size and SHA-256; full readiness requires successful local inference through both media encoders, not merely downloading files. The optional `embeddinggemma-2:270m` direct selection loads only the text backbone. Embeddings have **768 dimensions** and are normalized locally. Model assets/provenance are stored under the fs data directory, separately from SQLite. Runtime/quantization identity is recorded in the index; changing it never mixes incompatible vectors. Refresh other locations after a provider change.

**Verified on this Linux machine:** full direct CPU inference, image/PDF-page/audio/video semantic indexing in an isolated 2048 MiB worker, and real cross-modal retrieval from generic filenames without captions: cats-on-a-couch image similarity 74.1%, presidential-speech audio similarity 75.9%. These are cosine similarities, not confidence estimates. The original Ollama MLX variant remains incompatible here, but the direct route now works. The first native load takes longer; speed depends on hardware, text length, and corpus size.

Without uv: `python -m venv .venv`, activate it, then `python -m pip install -e '.[test]'`. Run `fs` from the activated environment. `npm start` also launches the desktop app and automatically finds `.venv`; set `FS_PYTHON` to use a different Python executable. On Linux/macOS the source launcher can reuse Electron 43+ from your PATH when npm's binary is missing. `FS_ELECTRON_PATH` explicitly selects an existing compatible runtime instead of downloading another copy.

Browser alternative: `uv run fs serve --open`. Both interfaces connect only to a loopback-bound service. The desktop uses Electron with sandboxing, context isolation, and Node integration disabled. Startup reports missing Python dependencies rather than silently installing software.

## File browser and built-in viewer

The compact browser has a collapsible sidebar (click the top-left fs logo), persistent **Favourites** for folders/selected files, file-type/date filters, and four layouts: a compact single-line table with tiny thumbnails and separate Location/Relevance/Size/date columns, detailed hybrid rows with excerpts, a thumbnail grid, or **Masonry** justified rows. Masonry keeps each thumbnail's aspect ratio, aligns heights within a row, and shows only the filename underneath; hovering or keyboard-focusing a thumbnail temporarily reveals details beside it. Click a column header to toggle ascending/descending name, relevance, size, modified, or creation-date sorting. Sorting applies to the entire matching set before the displayed-result limit. Relevance percentages are actual semantic cosine similarity, never a best-result normalization or confidence estimate. Once real timed media embeddings exist, filename fallback vectors cannot masquerade as content similarity. Failed/incomplete analysis is labelled **partial**; differing coverage can legitimately produce different scores even for identical files. Direct filename, keyword/path, and regex hits are labelled **Exact** rather than implying perfect semantic accuracy. The **Accuracy** slider above the search box controls minimum semantic similarity (0–1, default **0.68 / 68%**); raising it removes weaker semantic candidates. In Smart search, direct keyword matches remain eligible independently of semantic similarity. Pure Semantic mode applies the cutoff to every result.

Double-click a result to open it inside fs. Video/audio viewers have an always-visible, fully clickable/draggable seek bar directly beneath the player, with a live playhead and an icon toolbar with tooltips for play/pause, +/-10-second skips, restart, mute/volume, speed and video fullscreen controls. Arrow keys seek by 5 seconds (Shift: 10); Home/End seek to the ends. Recorded matches remain on the timeline and in an independently scrollable right-hand panel; narrow screens stack that panel below the player. **Play matches** plays the union of the listed timed intervals in chronological order, skips gaps without replaying overlapping matches, and pauses at the last boundary. Pause/resume keeps this mode; manual seeks or **Exit match mode** return to normal playback. Match-only mode and its paused position survive service reconnection. Files without recorded timed intervals cannot use this mode. Informational analysis warnings appear on a question-mark tooltip beside the title instead of taking up a row above the player; actual playback/loading errors remain visible. The viewer safely displays text/code and extracted DOCX text, renders PDF pages locally using bundled PDF.js, and plays supported images/audio/video. Literal/regex matches are highlighted; semantic related passages are separately marked. Images are not automatically OCR-analyzed. Unsupported binary formats have a bounded hexadecimal preview and an optional explicit system-app button. Text extraction remains limited to 100,000 characters / 100 PDF pages.

Video and audio thumbnails hover-play **muted**, seeking horizontally according to pointer position. Hold **Ctrl** while hovering to temporarily enable sound; releasing Ctrl, leaving the thumbnail, switching focus away, hiding the page, or refreshing results mutes the preview again. Ctrl already held when entering a thumbnail also works. This shortcut does not change the full viewer's audio settings. Hovered video/animated thumbnails show a seek strip and vertical playhead. Video search matches show start/end boundaries for recorded intervals: green for exact caption cues, amber for semantically matched sampled/indexed segments, not precise speech timestamps. Visible matching videos load only metadata, with at most two metadata requests at a time; no timestamps are fabricated for filename-only matches, unavailable sources, or unknown durations. Animated GIF/WebP/PNG thumbnails also play on hover; their actual frame durations map pointer position to animation time. The last pointer movement is retained even during throttling. Only one hover preview runs at once and releases its decoder on pointer leave or result refresh. Animated previews are bounded to 8 MiB input / 300 frames and decode locally through the browser; static images remain posters. Expiring media links refresh on hover. Viewer audio/video is muted by default too; the user may explicitly enable sound.

The desktop distinguishes intentional shutdown from unexpected search-service exit. Unexpected exits no longer close the application: it attempts up to three reconnections per five minutes, restoring search filters and the open viewer's position, pause/mute, volume and speed. Repeated failures leave the window open with a Retry connection button. An interrupted scan must be restarted; committed index records remain in SQLite. Bounded private diagnostics (`logs/search-service.log` in the desktop user-data directory, or the explicit `FS_DATA_DIR`) record exit codes/signals and stderr for diagnosis; reconnection is not a claim that every possible process crash/OOM is prevented.

If incomplete native audio/video analysis has a successfully analysed duplicate, `fs repair-duplicate --source-id ID --target-id ID` can recover its timed content embeddings. It verifies both entire files with streaming SHA-256, matching model/analysis settings, unchanged indexed fingerprints, and absence of captions; it refuses non-identical, changed, incompatible, captioned, or active-writer cases. This is explicit recovery, not automatic score normalisation. First-added dates and target filename metadata remain intact. Rescan older captioned files once to persist exact cue boundaries for thumbnail markers.

**Timed video/audio matches:** place `recording.srt` or `recording.vtt` beside `recording.mp4` (same filename stem), then refresh its location. fs indexes the caption text and real cue times. The viewer shows clickable start/end sections and timeline markers for literal caption matches and semantically related indexed passages. Semantic passages group up to 30 seconds of captions and obey the embedding-chunk budget. The full direct 740M model also embeds audio and sampled video content without captions. It decodes mono 16 kHz audio in consecutive 30-second segments and samples video frames at 0/10/20 seconds within each segment. Matching media vectors reference those actual analysed time ranges, not filename-derived timestamps. This is semantic speech/sound/scene retrieval, not automatic transcription: literal/regex spoken-word search and verbatim highlights still require caption text. Chunk budgets cap coverage, so long recordings may need a higher maximum-chunks setting and another rescan. Images and bounded PDF pages are embedded visually; PDF rendering and a fallback FFmpeg decoder are bundled. Unsupported/encrypted formats remain metadata-only. Captions are capped at 4 MiB / 5,000 cues.

Image posters use Pillow with a 32-megapixel budget. Video posters use optional host `ffmpeg` with limited threads/time; if it is unavailable, the file icon remains and hover preview still works for browser-supported codecs. Mainstream browser-supported media plays directly; other codecs can be opened explicitly in a system player. Thumbnails are cached locally, bounded to 1,000 completed entries. File streaming uses expiring, purpose-scoped signed URLs and byte ranges; only indexed files inside their original roots can be viewed, and source markup/macros are never executed.

## Mounted and offline sources

Explicit locations support locally accessible mounted drives and network filesystems, including Linux GVFS SMB paths under `/run/user/<uid>/gvfs/...`, `/run/media/...` removable drives, SMB/NFS/FUSE mounts, and platform-native mounted/UNC paths. Virtual process/device/runtime folders remain excluded. fs does not mount shares, collect network passwords, or implement arbitrary remote URLs: connect the source with your OS/file manager first.

Right-click a sidebar location or Locations card for **Open in file manager**, **Rescan location**, and **Re-check availability**. Sidebar counts show indexed files; hovering shows indexed / discovered total (unknown until rescanned). GVFS SMB locations open through their native SMB URI. On Linux, fs restores the installed user-session GVFS FUSE bridge when needed, without sudo or configuration changes. Slow pending probes remain checking rather than being incorrectly labelled offline; volume replacement still blocks indexing to protect cached records. Clicking an offline location also initiates a fresh bounded background check instead of waiting for the status cache. New scans queue behind the current one. **Stop all** cancels the current scan and clears the queue.

Indexing progress does not repeatedly rebuild results or sidebar entries: files remain clickable in List, Hybrid, and Thumbnails while a scan runs. Each active location has a narrow military-green progress bar. File discovery is indeterminate; after discovery, its percentage uses completed files / discovered files. The footer shows current counts and overall per-location batch completion, including queued sources (not an estimated remaining-time percentage).

Each record stores `indexed_at` (first added) and `analyzed_at` (last successful content/semantic analysis) as UTC Unix timestamps. Unchanged scans preserve those timestamps. Compact List columns expose both dates, with full local datetime tooltips, and the internal viewer shows full local datetimes. Legacy first-added times remain unknown rather than being fabricated; their next rescan records a fresh actual analysis time.

A location may be added while offline. Its cached metadata, extracted text, and vectors stay searchable, with online/offline status shown in the sidebar, Locations, and result rows. New offline locations have no results until their first successful index. Background, bounded source probes keep slow filesystem checks off the search HTTP thread. Refreshing a disconnected source preserves cached results rather than treating the missing volume as deleted files. Mount-source identity checks protect against pruning when a mount point falls back to a different volume; Linux identities remain stable across reconnects even when device numbers change. The viewer still requires the original file to be available for media/PDF access.

## User-wide Linux installation

After building the standalone Linux app (`npm run pack`), install it without sudo:

```sh
uv run python scripts/install_linux.py
fs --version
fs search "project proposal"
fs desktop
```

The installer copies only the standalone build to `~/.local/opt/fs/releases/<version>`, adds the `fs` CLI wrapper to `~/.local/bin`, and registers an **fs** desktop-menu entry under your XDG applications directory. It does not depend on this source checkout and refuses to overwrite existing installation files. `fs desktop` launches the installed GUI; use `FS_DATA_DIR` / `FS_MODEL` / `FS_OLLAMA_URL` environment variables for its overrides. Other CLI commands accept their usual global flags.

Share `dist/fs-0.6.0.AppImage` with its `.sha256` file. See `SHARING.md` for first-run model downloads and platform limitations. Packaging uses an explicit desktop/backend allowlist; the untracked `vault/` directory is neither copied nor packaged.

## CLI

```sh
# Select a mounted hard drive, or any folder
uv run fs index /mnt/my-drive

# Instant metadata/text indexing without a model
uv run fs index ~/Documents --no-semantic

# Natural-language + full-text search (default hybrid mode)
uv run fs search "notes about solar energy"
uv run fs search "expense report" --mode semantic
uv run fs search "invoice" --mode text
uv run fs search "report.pdf" --mode filename
uv run fs search 'invoice[_-]\d{4}' --mode regex

# Combine any mode with filters
uv run fs search "budget" --filename .pdf --modified-after 2025-01-01 --modified-before 2025-12-31
uv run fs search --created-after 2025-01-01 --root /mnt/my-drive --json

uv run fs status
uv run fs remove /mnt/my-drive  # index only; never removes your files
uv run fs about
```

`--limit` defaults to 50 (maximum 200). Omit the query to browse recently modified files. All search modes support additional filename, indexed-root, modified-time, and creation-time filters. Text mode matches all query words, with filename substring matches also included; regex searches filename and extracted content, case-insensitively. Semantic mode returns nearest files, not a yes/no content match. Hybrid mode combines lexical and semantic ranks and falls back to text with a warning when Ollama is unavailable.

Global options precede the command:

```sh
uv run fs --data-dir ./my-index --model embeddinggemma-2 --ollama-url http://127.0.0.1:11434 search "project proposal"
```

Use only a local Ollama URL for local-only operation. Changing the model requires semantic reindexing and clears incompatible embeddings across the index; refresh all locations afterwards. Filename and full-text data are preserved.

## Desktop

- Add a location via the native directory picker, including a mounted drive.
- Choose Smart (hybrid), Content, Filename, Semantic, or Regex.
- Expand Filters to combine filename, location, and date constraints.
- Open a result in its default desktop application.
- Monitor indexing, stop safely, and refresh/remove locations.
- Press `/` or `Ctrl+K` outside inputs to focus search.
- Preferences persists resource budgets, model selection, and dark/light theme.
- The default is a VS Code-inspired dark workspace with bundled JetBrains Mono typography, activity rail, location explorer, editor-like search view, and status bar.
- About includes the developer credit, GitHub link, and database location.

The responsive UI also works in a local browser. It has no hosted fonts, analytics, or remote frontend assets. JetBrains Mono (Nerd Font derivative) is bundled under the SIL Open Font License; see `fs/web/fonts/OFL.txt`.

## Resource preferences

Desktop preferences and `fs preferences` use the same application-data database. Accuracy and result layout also persist there, rather than being browser-only settings. The desktop polls for CLI changes and preserves unsaved form edits; saving those edits merges only changed fields. Explicit `--data-dir` selects a separate profile, and command-specific CLI overrides do not change saved settings.

The model field provides autocomplete for the published Ollama EmbeddingGemma 2 tags: 270M text, 440M text/vision, 570M text/audio, and 740M multimodal, with BF16/MXFP8/NVFP4 variants. See https://ollama.com/library/embeddinggemma-2/tags. The default 740M model and untagged/latest aliases use the full built-in ONNX runtime, and the 270M tag supports text-only direct inference. Precision-specific Ollama tags require a compatible optional Ollama runtime. Direct 740M enables visual PDF/image embeddings and bounded audio/video analysis; no external inference service is used.


Scanning and analysis run asynchronously in a **separate worker process** for both the CLI and desktop. The HTTP/UI service remains independent, SQLite writes are short transactions, and cancellation retains completed work. Workers run at low process priority, with idle disk-I/O priority on Linux.

Initial defaults:

| Preference | Default | Meaning |
| --- | --- | --- |
| CPU/inference threads | 2 | Total budget divided across active file workers, not granted to every worker |
| Parallel file workers | 2 | Bounded thread pool sharing one model; reduced automatically to fit CPU and memory headroom |
| Scan duty cycle | 25% | Active work followed by cancellable idle intervals |
| Worker memory | 2048 MiB | Linux virtual-address-space ceiling plus RSS watchdog; macOS/Windows RSS watchdog |
| Initial analysis size limit | 8 MiB | Larger files still indexed for filename/dates |
| Embedding chunks per file | 64 | Maximum semantic chunks retained per file |
| GPU acceleration | Off | CPU-only inference by default |
| Theme | Dark | VS Code-style workspace |

Set analysis size to **0** to remove the file-size eligibility limit. Unlimited mode discovers files into a disk-backed SQLite queue, then analyzes **smallest first**, pushing larger files down the queue without holding the path queue in RAM. Content extraction still retains its bounded text/page window, and the worker remains subject to its memory ceiling. Increase extraction/chunk budgets deliberately; a huge PDF can reach its memory budget and stop the worker after smaller files have been saved.

```sh
uv run fs model status
uv run fs model setup --direct            # download/run the exact model inside fs
uv run fs model setup --install-ollama    # explicitly approve private installation if missing
uv run fs preferences --embedding-backend auto
uv run fs preferences
uv run fs preferences --cpu-threads 2 --scan-duty-percent 25 --worker-memory-mb 1024 --max-file-mb 0
uv run fs preferences --theme light --use-gpu
uv run fs preferences --model embeddinggemma-2:270m --accuracy 0.68
uv run fs preferences --result-layout hybrid
uv run fs search "renewable power" --accuracy 0.8  # this query only
```

Changes apply to the next worker. Theme changes apply immediately. Parallel file analysis runs inside one isolated process, sharing the native model and bounded to at most the effective worker count of pending files. The coordinator alone commits SQLite updates and revalidates file fingerprints at commit. Remaining counts include in-flight files until their result is committed; discovery shows Counting instead of an invented estimate. Duty-cycle throttling remains approximate. On Linux with a working user systemd manager, each indexing job runs in a transient, automatically removed unit with aggregate `MemoryMax`, `MemorySwapMax=0`, `CPUQuota`, and `OOMPolicy=kill` covering every file thread and decoder descendant. No sudo, persistent service or system configuration changes are needed. Elsewhere CPU threads are divided and an aggregate process-tree RSS watchdog samples every 250 ms (not a hard tree cap); Linux also limits the worker's virtual address space. Limits cover the **index worker**, including direct model inference inside that worker, not the UI/search service’s model cache, operating system, other applications, or the separately running Ollama service. Tokenization is sequential to avoid an uncontrolled Rust/Rayon thread pool. Ollama/GPU memory is not hard-capped here, and no application can guarantee that the OS will never stall under every workload. CPU-only operation avoids model VRAM consumption by default.

## Cross-platform builds

Source execution supports **Linux, macOS, and Windows**. The Electron shell uses native directory dialogs and OS file-opening tools; Python uses platform-specific application-data directories, locks, priority controls, and memory accounting.

To build a desktop installer on its target OS:

```sh
uv sync --extra test --extra build
npm ci
uv run python scripts/build_backend.py
npm run dist
```

This bundles the Python backend, ONNX Runtime, tokenizer library, and dependencies with Electron; end users do not need Python or Node. Model weights are managed/downloaded at runtime rather than embedded in the installer. Ollama is optional and can be privately installed with explicit approval. Targets are Linux AppImage, macOS DMG, and Windows NSIS. The bundled `fs-service` executable also exposes the CLI. Installers are unsigned; production signing/notarization requires your certificates. Builds are native, not cross-compiled.

`.github/workflows/ci.yml` runs tests on all three operating systems. Its manually triggered packaging option builds downloadable artifacts without publishing a release. Linux source, source/packaged Electron UI, and frozen-backend execution were tested locally; macOS/Windows builds still require their matrix runs. Electron 43 and the release Electron 44 runtime both passed the local desktop UI smoke test. Setting a Git remote does not push or run GitHub CI automatically.

## Persistence and performance

SQLite stores metadata, extracted text, FTS5 full-text indexes, and float32 chunk embeddings in one persistent database. Vectors are loaded into a reusable normalized NumPy matrix for fast cosine search; multiple chunk hits collapse to one file result. The index lives outside the checkout by default:

- Linux: `$XDG_DATA_HOME/fs/index.sqlite3` or `~/.local/share/fs/index.sqlite3`
- macOS: `~/Library/Application Support/fs/index.sqlite3`
- Windows: `%LOCALAPPDATA%/fs/index.sqlite3`

Incremental indexing skips unchanged files, replaces changed chunks transactionally, and removes deleted entries after a successful scan. Cancelled or permission-incomplete scans do not prune unseen files. Searches can continue against a consistent SQLite WAL snapshot while indexing runs. The index contains readable copies of extracted content; keep its directory on a trusted disk. It is not encrypted.

Filename, date, and text search do not require model inference. Semantic latency includes query embedding and depends on CPU/GPU, model warm-up, and index size. The vector search is exact, not ANN: computation and RAM grow with the number of chunks. The application does not promise constant-time or instant searches on multi-million-file indexes. A first query loads vectors and may also load the model; subsequent searches reuse the matrix.

## File coverage and boundaries

- UTF-8 text, common source/config files, PDF text, and DOCX paragraphs/tables are extracted.
- All regular files are indexed for filename and modification time, including unsupported/binary formats.
- No file-size restriction applies to filename/date search. The initial content-analysis threshold is 8 MiB, adjustable or removable in Preferences. Extraction retains up to 100,000 characters and at most 100 PDF pages; the initial semantic limit is 64 overlapping chunks per file, configurable up to 256. Content beyond these extraction/chunk windows is not indexed. Direct inference caps each input at 1024 tokens and treats literal media-control markers in code as text rather than requesting nonexistent image/audio features.
- Scanned PDFs/images need external OCR; archive contents, media transcription, and encrypted PDFs are not extracted.
- Symlink files/folders, detected Windows junctions, `.git`, `.venv`, `node_modules`, caches, common system recycling folders, and Linux virtual system roots (`/proc`, `/sys`, `/dev`, `/run`) are skipped. File permissions are respected; no elevation is requested.
- True creation dates use `st_birthtime`, Linux `statx` birth time, or native Windows creation-time APIs. Missing filesystem birth times are NULL; Unix `ctime` is **not** mislabeled as creation time. Creation filters exclude unknown dates.
- Dates use ISO 8601. Date-only “before/through” includes that entire local-calendar day; datetime upper bounds are exclusive. Timezone-aware datetimes are accepted.
- Regex has a per-file timeout and a two-second total budget. Narrow filters for large regex searches.
- Indexing is explicit, not a live watcher. Refresh after edits or reconnecting a drive. Use non-overlapping locations where possible; a file belongs to the most recently indexed root.

## Verification

```sh
uv run pytest -q
npm run check
```

Tests also verify installation consent, the decline-to-direct route, automatic pulling, MLX fallback without substitution, checksums/resume, and sequential literal-safe tokenization. Tests exercise persistence, all search modes with deterministic embeddings, combined filters, incremental changes/deletions, cancellation, exclusion rules, invalid regex, offline fallback, index-only removal, preferences validation/persistence, unlimited-size ordering, worker isolation, cross-process locks, HTTP authorization, and static-asset security headers.

An optional real Electron UI smoke test uses Chromium's debugging protocol, not a simulated DOM:

```sh
# Use a fresh temporary index and a folder containing solar-notes.txt
FS_DATA_DIR=/tmp/fs-ui-db npm start -- --remote-debugging-port=9230
FS_UI_ROOT=/tmp/fs-ui-docs node scripts/ui_smoke.mjs
```

The test verifies dark theme/font, native-picker bridge, preferences navigation, asynchronous indexing, search/date filters, developer credit, mobile overflow, and browser exceptions. It writes desktop/mobile screenshots to temporary paths. For real managed semantic UI testing, provide a prepared/cached model in the test data directory and set `FS_UI_SEMANTIC=1`. The direct-runtime path has been tested locally.
