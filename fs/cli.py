from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from .core import DEFAULT_MODEL, Embedder, Store


def parser():
    p = argparse.ArgumentParser(prog="fs", description="Local-first semantic file search.")
    p.add_argument("--version", action="version", version=f"fs {__version__}")
    p.add_argument("--data-dir", type=Path, help="Index directory (default: your OS application-data directory)")
    p.add_argument("--model", help=f"Override saved Ollama model (initial default: {DEFAULT_MODEL})")
    p.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    sub = p.add_subparsers(dest="command", required=True)
    index = sub.add_parser("index", help="Incrementally index a directory or mounted drive")
    index.add_argument("root")
    index.add_argument("--no-semantic", action="store_true", help="Index metadata and text without Ollama")
    search = sub.add_parser("search", help="Search the persistent local index")
    search.add_argument("query", nargs="?", default="")
    search.add_argument("--mode", choices=["hybrid", "semantic", "text", "filename", "regex"], default="hybrid")
    search.add_argument("--filename", default="", help="Additional filename substring filter")
    search.add_argument("--root", default="", help="Limit to an indexed location")
    for flag in ["modified-after", "modified-before", "created-after", "created-before"]:
        search.add_argument("--" + flag, help="ISO date or datetime; before dates include that entire day")
    search.add_argument("--limit", type=int, default=50)
    search.add_argument("--json", action="store_true")
    search.add_argument('--accuracy', type=float, help='Override the shared minimum semantic similarity (0-1) for this search')
    sub.add_parser("status", help="Show indexed locations and model")
    repair = sub.add_parser('repair-duplicate', help='Recover incomplete media analysis from a byte-verified identical indexed file')
    repair.add_argument('--source-id', type=int, required=True)
    repair.add_argument('--target-id', type=int, required=True)
    prefs = sub.add_parser("preferences", help="Show or change persistent resource budgets")
    prefs.add_argument("--theme", choices=["dark", "light"])
    prefs.add_argument('--accuracy', type=float)
    prefs.add_argument('--result-layout', choices=['list', 'hybrid', 'grid', 'masonry'])
    prefs.add_argument('--model', dest='saved_model', help='Persist the model for both desktop and CLI')
    prefs.add_argument("--embedding-backend", choices=["auto", "direct", "ollama"])
    prefs.add_argument("--cpu-threads", type=int)
    prefs.add_argument('--file-workers', type=int)
    prefs.add_argument("--scan-duty-percent", type=int)
    prefs.add_argument("--worker-memory-mb", type=int)
    prefs.add_argument("--max-file-mb", type=int)
    prefs.add_argument("--max-chunks", type=int)
    prefs.add_argument("--use-gpu", action=argparse.BooleanOptionalAction, default=None)
    remove = sub.add_parser("remove", help="Remove a location from the index (never deletes source files)")
    remove.add_argument("root")
    web = sub.add_parser("serve", help="Run the local search interface in a browser")
    web.add_argument("--port", type=int, default=0)
    web.add_argument("--open", action="store_true")
    sub.add_parser("desktop", help="Launch the Electron desktop app from this checkout")
    model = sub.add_parser("model", help="Manage the embedding model and local runtimes")
    commands = model.add_subparsers(dest="model_command", required=True)
    commands.add_parser("status", help="Show managed runtime/model readiness")
    setup = commands.add_parser("setup", help="Automatically prepare the selected embedding model")
    choices = setup.add_mutually_exclusive_group()
    choices.add_argument("--direct", action="store_true", help="Download/run EmbeddingGemma 2 inside fs without Ollama")
    choices.add_argument("--install-ollama", action="store_true", help="Approve private Ollama installation if missing")
    sub.add_parser("about", help="About fs")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    if args.command == "about":
        print(f"fs {__version__}\nLocal-first file search.\nDeveloped by Chris Visser\nhttps://github.com/vcsoc/fs")
        return 0
    if args.command == "desktop":
        checkout = Path(__file__).resolve().parent.parent
        if not (checkout / "desktop/main.cjs").exists():
            print("Desktop launcher requires the source checkout; use `fs serve --open` instead.", file=sys.stderr)
            return 1
        import os
        env = {**os.environ, "FS_PYTHON": sys.executable, "FS_MODEL": args.model or "", "FS_OLLAMA_URL": args.ollama_url}
        if args.data_dir:
            env["FS_DATA_DIR"] = str(args.data_dir.resolve())
        return subprocess.call(["npm.cmd" if os.name == "nt" else "npm", "start"], cwd=checkout, env=env)
    manager = None
    try:
        store = Store(args.data_dir, Embedder(args.model, args.ollama_url))
        from .model_manager import ModelManager
        manager = ModelManager(store)
        def prepare(choice=None, progress=None):
            if choice is None and manager.status(probe=True)["needs_install_consent"]:
                if not sys.stdin.isatty():
                    raise RuntimeError("Model setup needs a choice. Run `fs model setup --direct` or `fs model setup --install-ollama` first.")
                answer = input("Ollama is not installed. Install a private runtime for fs? [y/N] (No uses EmbeddingGemma 2 directly): ")
                choice = "ollama" if answer.strip().lower() in {"y", "yes"} else "direct"
            return manager.prepare(choice=choice, progress=progress)
        if args.command == "index":
            def progress(state):
                if sys.stderr.isatty():
                    done = state.get('processed', state.get('scanned', 0))
                    remaining = f" / {max(0, state['total'] - done)} remaining" if state.get('phase') == 'indexing' and state.get('total') is not None else ''
                    print(f"\r{state.get('phase', 'indexing')}: {done} scanned{remaining} / {state.get('updated', 0)} updated / {state.get('path', '')[:80]}", end="", file=sys.stderr, flush=True)
            if not args.no_semantic:
                prepare(progress=progress)
            from .jobs import run_index
            result = run_index(store, args.root, semantic=not args.no_semantic, progress=progress)
            print(json.dumps(result, indent=2))
        elif args.command == "search":
            if args.mode in {"semantic", "hybrid"} and args.query and store.status()["chunks"] and store.embedder.provider == "ollama":
                prepare()
            result = store.search(minimum_relevance=args.accuracy if args.accuracy is not None else store.preferences()['accuracy'], **{k: v for k, v in vars(args).items() if k in {"query", "mode", "filename", "root", "limit", "modified_after", "modified_before", "created_after", "created_before"}})
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                for file in result["results"]:
                    stamp = datetime.fromtimestamp(file["modified"]).strftime("%Y-%m-%d %H:%M")
                    print(f"{file['path']}\n  {stamp}  {file['size']:,} bytes\n  {file['excerpt'].replace(chr(10), ' ')[:180]}")
                print(f"{result['total']} matches · {result['elapsed_ms']} ms", file=sys.stderr)
                if result["warning"]:
                    print("Warning: " + result["warning"], file=sys.stderr)
        elif args.command == 'repair-duplicate':
            from .duplicates import repair_duplicate
            print(json.dumps(repair_duplicate(store, args.source_id, args.target_id), indent=2))
        elif args.command == "status":
            print(json.dumps(store.status(), indent=2))
        elif args.command == "preferences":
            from .preferences import DEFAULTS
            values = {key: getattr(args, key) for key in DEFAULTS if getattr(args, key, None) is not None}
            if args.saved_model is not None:
                values['model'] = args.saved_model
            print(json.dumps(store.save_preferences(values), indent=2))
        elif args.command == "remove":
            store.remove_root(args.root)
            print("Location removed from index. Source files are unchanged.")
        elif args.command == "model":
            if args.model_command == "status":
                print(json.dumps(manager.status(probe=True), indent=2))
            else:
                choice = "direct" if args.direct else "ollama" if args.install_ollama else None
                result = prepare(choice, progress=lambda state: print(json.dumps(state), file=sys.stderr))
                print(json.dumps(result, indent=2))
        elif args.command == "serve":
            from .server import serve
            serve(store, args.port, args.open)
    except KeyboardInterrupt:
        print("\nStopped. Completed files remain indexed; rerun to resume.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"fs: {exc}", file=sys.stderr)
        return 1
    finally:
        if manager is not None:
            manager.close()
    return 0
