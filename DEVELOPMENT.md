# Developing draw.ai Desktop

draw.ai Desktop is an Electron shell around the editor in the `drawio` submodule. Product-specific workspace, template, AI, packaging, and operating-system integration belong on the `main` branch. Editor integration that must run inside the diagram canvas belongs on the `editor` branch of the same repository.

## Local setup

```bash
git clone --recursive https://github.com/tangf-ai/draw.ai.git
cd draw.ai
npm install
npm test
npm start
```

Node.js 22.12 or newer is required. Use `DRAWIO_ENV=dev npm start` when renderer development tools are needed.

## Required checks

Before submitting a change, run:

```bash
npm test
git diff --check
git -C drawio diff --check
```

Run `node --check` on changed JavaScript files. Changes to workspace or editor interaction also require Electron UI checks at normal and compact window sizes. Packaging changes require inspection of the packaged App ID, icons, update ownership, signature, and installer integrity.

## Repository boundaries

- Keep workspace filesystem access in `src/main/workspace-files.js`.
- Keep workspace Electron IPC and window orchestration in `src/main/workspace-window.js`.
- Keep AI credentials and network requests in the Electron main process.
- Preserve `contextIsolation`, sender validation, path containment, and symlink rejection.
- Keep `.drawio` compatibility and upstream attribution.

See [doc/UPSTREAM_MAINTENANCE.md](doc/UPSTREAM_MAINTENANCE.md) for the two-branch upstream maintenance workflow.
