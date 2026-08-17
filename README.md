# Plug and Play

Open-source demo of a **plug-and-play framework for creative spatial media**: connect a creative hardware device — a projector, a sensor, a light, a camera — and have the technical setup handled automatically, so practitioners can focus on the creative work instead of the configuration layer underneath it.

This repository is the first working implementation of that vision, focused on **projectors** for now — camera-based auto-calibration and projection mapping.

**Repository:** https://github.com/Avanividhani/plug-and-play  
**Releases (installers):** https://github.com/Avanividhani/plug-and-play-releases/releases

## What this project includes

- **Device detection** — connected displays, cameras, and audio endpoints
- **Auto-calibration (ProCam)** — Gray-code structured light maps camera pixels to projector pixels
- **Manual mapping** — draw shapes directly on the projector when no camera is available
- **Per-projector control** — two projectors can be calibrated and assigned content independently
- **Media library** — upload images and videos; assign them to mapped faces/shapes
- **AI generation** — text prompts for still images and motion video (cloud backends; works out of the box in packaged builds)
- **Cross-platform** — Windows, macOS, and Linux installers

## Requirements

- **Windows 10/11**, **macOS 11+**, or a recent **Linux** desktop (x64; Apple Silicon builds for macOS arm64)
- USB camera aimed at the projection surface (for auto-calibration)
- Projector connected as an **extended** display (not mirrored)
- Internet for AI generation (uploads work offline)

## Download and install

Prebuilt installers are on the [Releases](https://github.com/Avanividhani/plug-and-play-releases/releases) page.

| OS | File |
|----|------|
| **Windows** | `Plug and Play Setup 1.0.0.exe` (installer) or `Plug and Play 1.0.0.exe` (portable) |
| **macOS** | `Plug and Play-1.0.0.dmg` (Intel) or `Plug and Play-1.0.0-arm64.dmg` (Apple Silicon) |
| **Linux** | `Plug and Play-1.0.0.AppImage` or `plug-and-play_1.0.0_amd64.deb` |

### Windows

1. Run the Setup or portable `.exe`.
2. If SmartScreen appears: **More info → Run anyway**.
3. Open **Plug and Play**.

### macOS

1. Open the `.dmg` and drag **Plug and Play** to Applications.
2. If Gatekeeper blocks an unsigned build: **Right-click → Open → Open**.

### Linux

1. **AppImage:** `chmod +x Plug\ and\ Play-1.0.0.AppImage` then run it.
2. **deb:** `sudo dpkg -i plug-and-play_1.0.0_amd64.deb` (use `sudo apt-get install -f` if dependencies are missing).

## How to use (one projector + one camera)

1. Connect the projector and set the display to **Extend** (not Duplicate).
2. Mount the USB camera near the projector so it sees the same area.
3. Open the app and launch a fullscreen window on the projector display.
4. Select the camera and run **calibration** (stripe patterns flash for ~10–20 seconds).
5. Draw a shape on the camera view around your object or surface.
6. Upload media or **Generate** with a text prompt, then assign it to that shape.
7. Content appears on the physical object.

**Tips:** Flat, matte surfaces and moderate room lighting help calibration. If auto-calibration fails, use manual corner drawing.

## Run from source

Requires **Node.js 20+** and **npm**.

```bash
git clone https://github.com/Avanividhani/plug-and-play.git
cd plug-and-play
npm install
npm run electron:dev
```

Build installers for your platform:

```bash
npm run dist        # current OS
npm run dist:win    # Windows
npm run dist:mac    # macOS (on a Mac)
npm run dist:linux  # Linux
```

Output goes to `release/`. GitHub Actions (`.github/workflows/build.yml`) builds all three platforms on push/tag.

Optional: copy `electron/bundledKeys.example.ts` to `electron/bundledKeys.ts` and add API keys, or use a local `.env` (see `.env.example`).

## Tech stack

- **Electron** — desktop shell, IPC, local media server
- **React + TypeScript** — control UI (`ControlApp`) and projector views (`ProjectorView`)
- **Vite** — bundling and development
- **OpenCV.js** — Gray-code decode and geometry helpers
- **Pollinations / Google Veo** — cloud AI generation (when keys are configured)

## Troubleshooting

- **Blank window after install** — use the latest release installer; check `%APPDATA%\plug-and-play\startup-error.log` on Windows.
- **Wrong or missing projector output** — confirm **Extend** display mode; open the output on the correct monitor.
- **Calibration inaccurate** — reduce glare, check camera aim, or switch to manual mapping.
- **Video won't play** — restart the app so the local media server can start.
- **AI generate fails** — check internet connection; try a still image first.

## License

Open source — see repository for license terms.
