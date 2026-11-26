# Runtime maintenance

The two roster workflows (`sync-roster.yml`, `reconcile-roster.yml`) pin Node.js to `22.23.4`; `backend-contract-guard.yml` runs a shared checker from another repo and uses Node.js `24`. When updating the Node.js patch, change both roster workflow pins together and keep `contents: write` in `sync-roster.yml`, which the snapshot job needs to commit and push `data.json`.
