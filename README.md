# Plug and Play

A plug-and-play framework for creative spatial media: connect a creative hardware device — a projector, a sensor, a light, a camera — and have the technical setup handled automatically, so practitioners can focus on the creative work instead of the configuration layer underneath it.

This repository is a demo of this framework only demoing projector as hardware for now — the first working implementation of that vision, built around camera-based auto-calibration and projection mapping.

## Features

- **Dual projectors** — drive two displays; each can use **camera (ProCam) auto-calibration** or **manual** corner drawing
- **Faces / shapes** — detect or define surface regions to map content onto
- **Media library** — upload and assign photos and videos to regions / projectors
- **Video projection** — local video over a built-in HTTP media server (Range requests)
- **AI generate** — text-prompt stills and motion video via a configured backend (works out of the box; no API key paste required)

## Requirements

- **Windows 10/11**, **macOS 11+**, or a recent **Linux** desktop (x64)
- For development: **Node.js 20+** (developed with Node 22) and **npm**
- USB camera aimed at the projection surface (for auto-calibration)
- Projector(s) / extra displays as extended outputs (not mirrored)

## Download (prebuilt)

Builds are produced by GitHub Actions and attached to [Releases](https://github.com/Avanividhani/plug-and-play/releases) (and as workflow artifacts). Pick the file for your OS:

| OS | File |
|----|------|
| **Windows** | `Plug and Play Setup 1.0.0.exe` (installer) or `Plug and Play 1.0.0.exe` (portable) |
| **macOS** | `Plug and Play-1.0.0.dmg` or `Plug and Play-1.0.0-mac.zip` |
| **Linux** | `Plug and Play-1.0.0.AppImage` or `plug-and-play_1.0.0_amd64.deb` |

Private repo: you need collaborator access (see below) before Releases are visible.

### Install — Windows

1. Download the Setup or portable `.exe`.
2. If SmartScreen appears: **More info → Run anyway**.
3. Run the installer (or the portable exe) and open **Plug and Play**.

### Install — macOS

1. Download the `.dmg` (or unzip the `.zip`).
2. Drag **Plug and Play** to Applications (dmg) or open the app from the zip.
3. If Gatekeeper blocks an unsigned build: **Right-click the app → Open → Open**.

### Install — Linux

1. **AppImage:** `chmod +x "Plug and Play-1.0.0.AppImage"` then run it.
2. **deb:** `sudo dpkg -i plug-and-play_1.0.0_amd64.deb` (fix dependency issues with `sudo apt-get install -f`).

## Run from source (any OS)

```bash
git clone https://github.com/Avanividhani/plug-and-play.git
cd plug-and-play
npm install
npm run electron:dev
```

Equivalent: `npm run dev` / `npm start` also start the Vite + Electron workflow.

AI Generate uses bundled backend keys when environment variables are empty — no UI key paste. Optional overrides via a local `.env` (gitignored) are supported for development only.

## How to use

1. **Displays** — attach projector(s). Use **Extend** / multi-monitor arrangement (not Duplicate / mirror). Prefer native projector resolution; avoid aggressive hardware keystone when possible.
2. **Camera** — select the USB camera aimed at the surface (prefer external over a built-in webcam).
3. **Calibrate** — run camera (ProCam) auto-calibration, or switch to manual corner drawing.
4. **Content** — pick faces/shapes, assign library media, or use **Generate** for AI stills/motion.
5. **Project** — open fullscreen projector windows on the extended displays and project.

### Hardware / display notes

- **Windows:** Display settings → **Extend** these displays.
- **macOS:** System Settings → Displays — arrange as separate spaces (not Mirror).
- **Linux:** use your desktop’s display settings for extended outputs (e.g. Settings → Displays).

## Building packages

### Locally (this machine’s OS)

```bash
npm install
npm run dist          # current platform (win / mac / linux targets in package.json)
npm run dist:dir      # unpacked dir only
```

On Windows you typically get NSIS + portable under `release/`. Full macOS `.dmg` builds need a Mac (or CI). Linux AppImage/deb can often be produced from Linux CI (and sometimes cross-built depending on electron-builder setup).

### GitHub Actions (all platforms)

Workflow: `.github/workflows/build.yml`

- Triggers: `workflow_dispatch`, pushes to `master`/`main`, and version tags `v*`
- Jobs on `windows-latest`, `macos-latest`, `ubuntu-latest`
- Uploads artifacts and attaches files to a GitHub Release on tags

Manual run (with [GitHub CLI](https://cli.github.com/) authenticated):

```bash
gh workflow run build.yml
```

Or: **Actions → Build → Run workflow** in the GitHub UI.

## Devices (this demo)

| Device | Status in this demo |
|--------|---------------------|
| **Projector** | Supported — auto-calibration + projection mapping |
| **Camera** | Used for calibration / capture |
| Sensor / light / other creative hardware | Framework vision — not implemented in this demo yet |

## Troubleshooting

- **SmartScreen (Windows)** — unsigned build: More info → Run anyway.
- **Gatekeeper (macOS)** — Right-click → Open on unsigned builds.
- **AppImage won’t start** — `chmod +x` the file; install FUSE if your distro requires it for AppImages.
- **Blank / wrong projector image** — confirm extended (not mirrored) displays; open the correct output window.
- **App blank or closes on start (Windows)** — check `%APPDATA%\plug-and-play\startup-error.log`.
- **Video won’t play** — restart so the local media server can bind; confirm nothing blocks localhost.
- **Auto-cal fails** — USB camera on the surface, good lighting, markers in frame; or use manual corners.
- **AI generate fails** — needs network access to the configured generation backends.

## Tech stack

- **Electron** — desktop shell, displays, media server
- **React** + **TypeScript** — control UI and projector views
- **Vite** (+ vite-plugin-electron) — bundling and `electron:dev`
- **OpenCV.js** — calibration / surface geometry helpers
- Cloud generation backends used by the packaged app when bundled keys / env are present

## License

Use and share as needed within this private repository’s collaborator access.
