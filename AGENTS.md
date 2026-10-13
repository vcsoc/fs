# Project Workflow

For every completed user-requested change:

1. Bump the application version to match the change (SemVer; patch for fixes, minor for compatible features, major for breaking changes).
2. Keep package.json/package-lock.json, pyproject.toml/uv.lock, fs/__init__.py and the About UI version consistent.
3. Run the test suite and JavaScript checks; rebuild the standalone backend and desktop application.
4. Verify the packaged application and generate/check the AppImage checksum. Close every application instance opened for testing immediately after verification; preserve the user's normal window and active scans.
5. Commit the relevant source changes and push to origin. Never force-push.
6. After the successful commit and push, atomically update the user's installed release to the latest verified build. Preserve previous releases and user data. Do not open extra normal windows unless requested; never interrupt active scans without permission.

Report any build, install, verification or push failure rather than claiming completion.

Treat one completed task/change batch as one release, not each intermediate file edit. Do not commit failing or unfinished fixes as completed work.

Never inspect, stage, package or modify vault/. Exclude local databases, models, annotations, environments and build artifacts. Preserve unrelated user changes. Run only explicitly authorized tasks; do not infer permission to delegate to other agents.
