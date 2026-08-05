# Building draw.ai locally

Clone the desktop branch and its editor submodule, then install dependencies:

```bash
git clone --recursive https://github.com/tangf-ai/draw.ai.git
cd draw.ai
npm install
npm test
```

Start the desktop application with `npm start`.

## Unsigned macOS build

```bash
DRAWIO_UNSIGNED=true CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --config electron-builder-linux-mac.json \
  --mac dmg --arm64 --publish never
```

Unsigned builds are for local testing. macOS may require a user-approved first launch. Public distribution should use a Developer ID controlled by the draw.ai project and Apple notarization.

## Unsigned Windows build

Set `DRAWIO_UNSIGNED=true`, then run electron-builder with `electron-builder-win.json` and `--publish never`. Public distribution should use a Windows signing identity controlled by the draw.ai project.

## Linux build

Run electron-builder with `electron-builder-linux-mac.json` and `--publish never`. The executable name is `draw-ai`.

The GitHub Actions workflow `Unsigned draw.ai Build` performs equivalent manual builds without repository secrets.
