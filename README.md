# YouTrackd

Gitify for YouTrack — a lightweight Tauri v2 desktop app that brings YouTrack Cloud notifications to the system tray with quick actions.

## Download

Grab the latest release from the [Releases page](https://github.com/protomated/youtrackd/releases).

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `.dmg` (aarch64) |
| macOS (Intel) | `.dmg` (x86_64) |
| Windows | `.msi` or `.exe` |
| Linux (Debian/Ubuntu) | `.deb` |
| Linux (Other) | `.AppImage` |

## Running Unsigned Builds

This app is not code-signed. Your OS will block it by default. Follow the instructions below for your platform.

### macOS

**Option A — Right-click to open (simplest):**

1. Open Finder and navigate to the app (in `/Applications` or wherever you dragged it)
2. **Right-click** (or Control-click) the app and select **Open**
3. A dialog will appear saying the app is from an unidentified developer — click **Open**
4. You only need to do this once; subsequent launches work normally

**Option B — Remove the quarantine attribute:**

```sh
xattr -cr /Applications/YouTrackd.app
```

Then open the app normally.

**Option C — System Settings (if the above don't work):**

1. Try to open the app (it will be blocked)
2. Go to **System Settings → Privacy & Security**
3. Scroll down — you'll see a message about YouTrackd being blocked
4. Click **Open Anyway**

### Windows

When you see the "Windows protected your PC" SmartScreen dialog:

1. Click **More info**
2. Click **Run anyway**

### Linux

AppImage files need to be made executable first:

```sh
chmod +x YouTrackd_*.AppImage
./YouTrackd_*.AppImage
```

For `.deb` packages, install with:

```sh
sudo dpkg -i youtrackd_*.deb
```

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (LTS)
- [pnpm](https://pnpm.io/)
- Platform-specific dependencies:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - **Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), WebView2 (pre-installed on Windows 10+)

### Setup

```sh
pnpm install
pnpm tauri dev
```

### Build

```sh
pnpm tauri build
```

## Releasing

Releases are fully automated via [release-please](https://github.com/googleapis/release-please) and GitHub Actions. Versions are determined from [Conventional Commits](https://www.conventionalcommits.org/).

### Commit conventions

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `fix:` | Patch (`0.1.0` → `0.1.1`) | `fix: prevent duplicate notifications` |
| `feat:` | Minor (`0.1.0` → `0.2.0`) | `feat: add quick-assign action` |
| `feat!:` or `BREAKING CHANGE:` | Major (`0.x` → `1.0.0`) | `feat!: redesign settings API` |

Other prefixes (`chore:`, `docs:`, `ci:`, `refactor:`, `test:`) do not trigger a release.

### How it works

1. **Push conventional commits to `main`** — write your commits as usual.
2. **Release PR appears automatically** — release-please opens (or updates) a PR titled _"chore(main): release vX.Y.Z"_. This PR bumps versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, and generates `CHANGELOG.md`.
3. **Merge the Release PR** — when you're ready to cut a release, merge it.
4. **Builds run automatically** — GitHub Actions builds for macOS (ARM + Intel), Windows, and Linux. This takes roughly 15-20 minutes.
5. **Review the draft release** — Go to [GitHub Releases](https://github.com/protomated/youtrackd/releases). The workflow creates a **draft** pre-release with all platform artifacts attached. Review, edit notes if needed, then click **Publish release**.

### What gets built

| Runner | Target | Artifacts |
|--------|--------|-----------|
| `macos-latest` | `aarch64-apple-darwin` | `.dmg`, `.app` (Apple Silicon) |
| `macos-latest` | `x86_64-apple-darwin` | `.dmg`, `.app` (Intel Mac) |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.deb`, `.AppImage` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `.msi`, `.exe` |

### First-time setup (bootstrap)

Before release-please can manage versions, you need to create a baseline tag so it knows where to start counting commits:

```sh
# 1. Commit all the release infrastructure (this should already be done)
git add -A
git commit -m "chore: add release-please and CI workflow"

# 2. Create the baseline v0.1.0 tag on this commit
git tag v0.1.0

# 3. Push everything
git push origin main --tags
```

After this, any conventional commits pushed to `main` will cause release-please to open a Release PR for the next version. You never need to manually create tags again.

### Version scheme

This project uses `v0.x.y` pre-release versioning. All releases are marked as pre-release until `v1.0.0`.

### GitHub repo settings

For the workflow to function, ensure **Settings > Actions > General > Workflow permissions** is set to **Read and write permissions**.

## License

[MIT](LICENSE)
