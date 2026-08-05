<p align="center">
  <img src="build/icon.svg" width="112" alt="draw.ai logo">
</p>

<h1 align="center">draw.ai</h1>

<p align="center">
  A local-first desktop workspace for creating and managing diagrams with AI.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · English
</p>

<p align="center">
  <a href="https://github.com/tangf-ai/draw.ai/actions/workflows/ci.yml"><img src="https://github.com/tangf-ai/draw.ai/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache License 2.0"></a>
</p>

draw.ai brings a unified file workspace, reusable templates, image-aware AI assistance, and the mature draw.io editor into one open-source desktop application. Diagrams remain standard, editable `.drawio` files.

> draw.ai is an independent community project based on the Apache-2.0-licensed draw.io projects. It is not affiliated with, endorsed by, or supported by draw.io Ltd or JGraph. draw.io is a trademark of its respective owner.

## Features

- **Unified workspace**: create folders and diagrams, search, import, rename, duplicate, move, reveal, and move files to the system trash from one window.
- **Reusable diagram template**: configure the content used for every new diagram.
- **Synchronized template source**: track a template in iCloud Drive or another synchronized folder, detect newer external versions, and explicitly update the local hidden working copy.
- **AI diagram assistant**: discuss the current diagram, generate editable shapes, apply proposed changes, and roll back the most recent AI application.
- **Image-to-diagram**: upload, paste, or drag a PNG, JPEG, or WebP image. The assistant can reconstruct a screenshot or hand-drawn sketch as editable boxes, connectors, text, and hierarchy.
- **Configurable AI provider**: use an OpenAI-compatible endpoint and configure the API key, model, system prompt, and optimization instructions inside the app.
- **Cross-platform packaging**: macOS, Windows, and Linux build configurations are included.

## Quick start

Requirements: Git, Node.js 22.12 or newer, and npm.

```bash
git clone --recursive https://github.com/tangf-ai/draw.ai.git
cd draw.ai
npm install
npm test
npm start
```

The repository uses two branches in the same GitHub project:

- `main`: Electron desktop application and workspace features.
- `editor`: draw.ai's editor fork, checked out at `drawio/` as a Git submodule.

If the repository was cloned without `--recursive`, initialize the editor with:

```bash
git submodule update --init --recursive
```

## Using the AI assistant

1. Open a diagram and select the **AI Assistant** tab in the right sidebar.
2. Open AI settings and configure an OpenAI-compatible base URL, API key, and vision-capable model when using images.
3. Enter a request, or paste, upload, or drag in a reference image.
4. Review the proposed diagram update before applying it.
5. Use **Roll back** to undo the latest applied AI change.

Images are resized locally when needed and sent only with the request that includes them. The default limit is 10 MB, with the longest edge reduced to 2048 pixels before submission.

## Templates and iCloud

The editable working template is stored as a hidden file managed by draw.ai. Importing or updating a template replaces that hidden working copy after confirmation. When the source template is stored in iCloud Drive, draw.ai records the source and checks whether it has changed before the template is used or managed; synchronization of the source file itself remains iCloud's responsibility.

## Privacy

Workspace and diagram editing are local by default. AI requests are made only after the user configures a provider and submits a message. A request may contain the prompt, configured instructions, relevant diagram structure, and an attached image. Review the privacy and retention terms of the selected AI provider.

The application checks this GitHub repository for updates unless checks are disabled with `DRAWIO_DISABLE_UPDATE=true` or `--disable-update`. Diagrams can also load external media referenced by URL.

## Development and packaging

Use `DRAWIO_ENV=dev npm start` to open renderer development tools. Before submitting a change, run:

```bash
npm test
git diff --check
git -C drawio diff --check
```

Create an unsigned Apple Silicon macOS installer with:

```bash
DRAWIO_UNSIGNED=true CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --config electron-builder-linux-mac.json \
  --mac dmg --arm64 --publish never
```

Unsigned artifacts are intended for local testing. Public macOS releases should use a project-controlled Developer ID and Apple notarization.

More information:

- [Development guide](DEVELOPMENT.md)
- [Local build guide](doc/BUILDING_FOR_PERSONAL_USE.md)
- [Upstream maintenance](doc/UPSTREAM_MAINTENANCE.md)
- [Release process](doc/RELEASE_PROCESS.md)
- [Security policy](SECURITY.md)

## Compatibility and license

The application uses its own identifiers (`ai.draw.desktop`, `ai.draw.diagram`, and `draw-ai`) while retaining the `.drawio` extension and `application/vnd.jgraph.mxfile` MIME type for compatibility.

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
