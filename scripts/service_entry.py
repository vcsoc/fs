"""Minimal frozen entry: worker budgets are applied before importing the backend."""
import sys

if len(sys.argv) > 1 and sys.argv[1] == "--worker":
    sys.argv.pop(1)
    from fs.worker import main
else:
    from fs.cli import main

raise SystemExit(main())
