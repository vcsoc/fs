# fs 0.2.0 for Linux x86_64

Share `fs-0.2.0.AppImage` and `fs-0.2.0.AppImage.sha256` together.

```sh
sha256sum -c fs-0.2.0.AppImage.sha256
chmod +x fs-0.2.0.AppImage
./fs-0.2.0.AppImage
```

This unsigned AppImage includes Electron, the Python backend, ONNX Runtime, tokenizer dependencies, PDF rendering and a fallback FFmpeg decoder. Recipients do not need Node.js, Python, Ollama or system FFmpeg. This artifact is for Linux x86_64, not Windows/macOS.

Model weights are downloaded separately. The default `embeddinggemma-2:740m` setup downloads approximately 505 MB of checksum-pinned text, vision and audio assets and verifies real inference before reporting Ready. Subsequent direct inference works offline. Optional Ollama variants remain available, but are not required by the default runtime.

Images, PDF pages, audio and sampled video content support semantic retrieval. Speech embeddings are not verbatim transcripts; caption-backed literal search requires a same-name SRT/VTT file. Chunk, image and document-size budgets limit coverage. Unsupported/encrypted formats remain metadata-only.

Each recipient gets their own local preferences, model cache and SQLite/vector database. The artifact does not contain the developer's index, personal file contents, model cache, annotations or vault directory.

Parallel file workers share one model and one indexing budget. On Linux with a working user systemd manager, transient process-tree memory/CPU caps include decoder helpers. Other environments use divided thread budgets and a sampled aggregate RSS watchdog rather than a hard process-tree cap.

If the host lacks FUSE support, try:

```sh
./fs-0.2.0.AppImage --appimage-extract-and-run
```

Tested on the development Linux machine; AppImage does not guarantee compatibility with every distribution or older system-library version. macOS/Windows artifacts are not locally verified.

Developed by Chris Visser
https://github.com/vcsoc/fs
