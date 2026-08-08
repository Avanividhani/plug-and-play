# Plug and Play

Projection mapping for Windows: map content onto surfaces with one or two projectors, calibrate with a USB camera (ProCam-style auto) or by drawing corners manually, then assign media — including optional AI-generated stills and video.

## What it is

**Plug and Play** is an Electron desktop app for classroom / lab projection mapping. You extend Windows across your projector displays, open fullscreen projector windows, calibrate the warp to the physical surface, pick faces or shapes, assign images/video from a media library (or generate with AI when API keys are set), and project.

## Features

- **Dual projectors** — drive two displays; each projector can use **camera (ProCam) auto-calibration** or **manual** corner drawing.
- **Faces / shapes** — detect or define surface regions (faces) to map content onto.
- **Media library** — upload and assign photos and videos to regions / projectors.
- **Video projection** — local video is served over a built-in local HTTP media server (Range requests) so playback works in the projector views.
- **AI generate** (optional) — text-prompt generation via **Pollinations** and/or **Gemini** when you provide API keys (UI Save, `.env`, or a local `electron/bundledKeys.ts` used only when you package an installer yourself).

## Requirements

- **Windows 10 / 11, x64**
- **Node.js** 20+ recommended (developed with Node 22); **npm**
- **USB camera** aimed at the projection surface for auto-calibration
- Projectors / extra displays in Windows **Extend** mode (not Duplicate)
- Optional: Gemini (`AIza…`) and/or Pollinations API keys for AI features

## Setup from source

```bash
git clone https://github.com/<your-username>/plug-and-play.git
cd plug-and-play
npm install
```

Optional environment keys (copy `.env.example` → `.env`; never commit `.env`):

```env
# Optional — Google AI Studio / Gemini (must start with AIza)
GEMINI_API_KEY=

# Optional — Pollinations (Motion / still generation)
POLLINATIONS_API_KEY=
```

You can also paste keys in the app Content UI and Save (stored under the app userData folder, not in git).

Run the app in development (Vite + Electron via the project scripts):

```bash
npm run electron:dev
```

Equivalent scripts in this repo: `npm run dev` and `npm start` also start Vite the same way. Use **Open** / projector controls in the UI to fullscreen outputs on each extended display.

For packaging defaults only on *your* machine, copy `electron/bundledKeys.example.ts` → `electron/bundledKeys.ts` and fill placeholders. **`bundledKeys.ts` is gitignored** — do not commit real keys (especially for coursework / professor clones).

## How to use

1. **Connect displays** — attach projector(s). In Windows Display settings, set mode to **Extend** (not Duplicate). Use each projector’s native resolution when possible; avoid aggressive keystone if you can.
2. **Start the app** — `npm run electron:dev` (or run the built installer).
3. **Open projectors** — from the control UI, open fullscreen output windows on the projector displays.
4. **Calibrate**
   - **Camera / ProCam:** select the USB camera (prefer external over the laptop webcam), aim it at the surface, run auto-calibration so markers are projected and a homography / mapping is solved.
   - **Manual:** switch the projector to manual mode and draw / adjust corner targets for the surface.
5. **Select faces / shapes** — review detected or preset surfaces and choose the regions you want to map.
6. **Assign media** — add images/videos in the media library and assign them to faces / projectors.
7. **Generate AI** (optional) — enter a prompt and generate with Pollinations / Gemini if keys are configured; otherwise skip this step.
8. **Project** — project the selected content to the outputs. With two projectors, use overlap / blend controls if available for a wider seamless image.

## Building an installer

On a Windows x64 machine with dependencies installed:

```bash
npm install
npm run dist
```

Artifacts are written under `release/`, for example:

- `Plug and Play Setup 1.0.0.exe` — NSIS installer  
- `Plug and Play 1.0.0.exe` — portable build  

(`npm run dist:dir` builds an unpacked directory without the full installer.)

## Sharing

| What to send | Notes |
|--------------|--------|
| Installer / portable `.exe` from `release/` | Recipients do not need Node. Windows SmartScreen may warn on unsigned builds — **More info → Run anyway**. |
| Source repo | Recipients run `npm install` and follow Setup. |

AI features need **each person’s own API keys** unless you privately package an installer with your own local `bundledKeys.ts` (not for class sharing). For a professor cloning this repo: **do not commit real keys**; they can add their own via `.env` or the UI.

## Troubleshooting

- **SmartScreen** — unsigned app: choose More info → Run anyway.
- **Blank / wrong image on projector** — confirm **Extend**, not Duplicate; open the correct display’s projector window.
- **App blank or closes on start** — check `%APPDATA%\plug-and-play\startup-error.log`.
- **Video won’t play** — the app starts a local HTTP media server automatically for Range-capable URLs; if video fails, restart the app and confirm nothing else is blocking localhost.
- **Auto-cal fails** — use a USB camera pointed at the surface, good lighting, and markers visible in frame; fall back to manual corner calibration.
- **AI generate fails** — verify keys (Gemini must be `AIza…`; Pollinations key as issued by their site) and network access.

## Tech stack

- **Electron** — desktop shell and display / media server
- **React** + **TypeScript** — control UI and projector views
- **Vite** (+ vite-plugin-electron) — bundling and electron:dev workflow
- **OpenCV.js** (`@techstark/opencv-js`) — calibration / surface geometry helpers
- Optional cloud APIs: **Pollinations**, **Google Gemini** (when keyed)

## License / coursework

Use and share as needed for class. Keep secrets out of git.
