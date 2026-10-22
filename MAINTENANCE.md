# Runtime maintenance

Both GitHub Actions workflows pin Node.js to `22.23.4`. When updating the Node.js patch, change both workflow pins together and keep `contents: write` in `sync-roster.yml`, which the snapshot job needs to commit and push `data.json`.
