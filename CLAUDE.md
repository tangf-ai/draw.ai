# draw.ai Desktop development notes

draw.ai is an independent Electron desktop application based on the Apache-2.0-licensed draw.io projects. Preserve upstream copyright and attribution, but do not reintroduce upstream product branding, signing identities, private repositories, update feeds, funding links, or store ownership.

## Architecture

- `src/main/electron.js` is the Electron main process and editor-window integration.
- `src/main/workspace-files.js` owns workspace filesystem validation and operations.
- `src/main/workspace-window.js` owns workspace IPC and its isolated BrowserWindow.
- `src/workspace/` contains the workspace renderer and preload bridge.
- `src/main/ai-assistant.js` owns AI configuration, credential storage, requests, and response validation.
- `drawio/` is the editor submodule. The built-in AI panel is in `drawio/src/main/webapp/plugins/ai-assistant.js`.

Keep Electron renderer processes isolated. Do not enable Node integration, weaken CSP or sender checks, allow path traversal, follow workspace symlinks, expose AI keys to renderers, or overwrite user files without explicit confirmation.

## Product identities

- Product name: `draw.ai`
- App ID: `ai.draw.desktop`
- macOS diagram UTI: `ai.draw.diagram`
- Linux executable: `draw-ai`
- Repository: `tangf-ai/draw.ai`
- Desktop branch: `main`
- Editor branch: `editor`

Keep the `.drawio` extension and `application/vnd.jgraph.mxfile` MIME type for compatibility.

## Verification

Run `npm test`, syntax checks for changed JavaScript, JSON parsing for package/build configuration, `git diff --check`, and `git -C drawio diff --check`. UI changes require Electron interaction checks. Packaging changes require app/installer metadata inspection plus platform integrity and signature checks.
