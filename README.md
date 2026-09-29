# Feedglance

Gitify for YouTrack — a lightweight Tauri v2 desktop app that brings YouTrack Cloud notifications to the system tray with quick actions.

## Download

Grab the latest release from the [Releases page](https://github.com/protomated/feedglance/releases).

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
xattr -cr /Applications/Feedglance.app
```

Then open the app normally.

**Option C — System Settings (if the above don't work):**

1. Try to open the app (it will be blocked)
2. Go to **System Settings → Privacy & Security**
3. Scroll down — you'll see a message about Feedglance being blocked
4. Click **Open Anyway**

### Windows

When you see the "Windows protected your PC" SmartScreen dialog:

1. Click **More info**
2. Click **Run anyway**

### Linux

AppImage files need to be made executable first:

```sh
chmod +x Feedglance_*.AppImage
./Feedglance_*.AppImage
```

For `.deb` packages, install with:

```sh
sudo dpkg -i feedglance_*.deb
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

Releases are fully automated by GitHub Actions (`.github/workflows/release.yml`). Every push to `main` is checked, and if it contains a release-worthy commit, a new version is built and published with no manual steps.

### Version scheme

Feedglance uses calendar versioning in the form **`YY.M.PATCH`**:

| Part | Meaning | Example |
|------|---------|---------|
| `YY` | Two-digit UTC year | `26` = 2026 |
| `M` | UTC month, **not** zero-padded | `9` = September, `10` = October |
| `PATCH` | Release number within that month, starting at `0` | `0`, `1`, `2`… |

So the first release in October 2026 is `26.10.0`, the next is `26.10.1`, and the first in November is `26.11.0`. Tags are prefixed `feedglance-v` (e.g. `feedglance-v26.10.0`).

These constraints are deliberate:

- **Two-digit year:** Windows MSI installers cap the first two version fields at 255, so `2026.x.x` cannot be built.
- **No zero-padding:** `26.09.0` is not a valid semver string, which Cargo and the Tauri updater both require.

Versions before `26.x` used semver (`0.1.0`–`0.10.0`). CalVer versions sort above them, so existing installs update normally.

### What triggers a release

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). The prefix decides **whether** a push releases; the date decides the version number.

| Prefix | Releases? | Example |
|--------|-----------|---------|
| `feat:` | Yes | `feat: add quick-assign action` |
| `fix:` / `perf:` | Yes | `fix: prevent duplicate notifications` |
| `feat!:` / `BREAKING CHANGE:` footer | Yes, with a breaking-change notice at the top of the release notes | `feat!: drop macOS 11 support` |
| `chore:` / `ci:` / `docs:` / `refactor:` / `test:` | No | `docs: fix typo` |

Add `[skip ci]` or `[skip release]` to the **last** commit of a push to stop that push from releasing.

### How it works

1. **Push to `main`.** The `version` job scans commits since the last tag. If none are release-worthy, the workflow stops.
2. **Version and tag.** It computes the next `YY.M.PATCH`, writes it to `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock`, commits `chore(release): X [skip ci]`, and pushes the tag. It fails if the new version would not be higher than the last one, since the updater would ignore it.
3. **Build.** macOS (Apple Silicon and Intel), Windows, and Linux build in parallel and upload to a draft release. This takes roughly 15–20 minutes.
4. **Publish.** When every build succeeds, the release is published and marked **latest**, which is what the in-app updater reads.

Notes are generated from the commits. Installed apps pick up the update on their next check.

### Manual release

Run the **Release** workflow from the Actions tab and enter a tag, e.g. `feedglance-v26.10.3`. It must follow `YY.M.PATCH`; anything else is rejected.

### What gets built

| Runner | Target | Artifacts |
|--------|--------|-----------|
| `macos-latest` | `aarch64-apple-darwin` | `.dmg`, `.app` (Apple Silicon) |
| `macos-latest` | `x86_64-apple-darwin` | `.dmg`, `.app` (Intel Mac) |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.deb`, `.rpm`, `.AppImage` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `.msi`, `.exe` |

### GitHub repo settings

For the workflow to function, ensure **Settings > Actions > General > Workflow permissions** is set to **Read and write permissions**.

## License

[MIT](LICENSE)
