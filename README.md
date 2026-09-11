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

draw.ai brings a unified file workspace, reusable templates, a Pi-powered diagram Agent, and the mature draw.io editor into one open-source desktop application. Diagrams remain standard, editable `.drawio` files.

> draw.ai is an independent community project based on the Apache-2.0-licensed draw.io projects. It is not affiliated with, endorsed by, or supported by draw.io Ltd or JGraph. draw.io is a trademark of its respective owner.

<p align="center">
  <img src="docs/images/editor-workspace.png" width="100%" alt="draw.ai editor with the unified workspace and a sample architecture diagram">
</p>

<p align="center"><sub>Manage diagram files and use the full draw.io editor in one desktop window.</sub></p>

## Features

- **Unified workspace**: create folders and diagrams, search, import, rename, duplicate, move, reveal, and move files to the system trash from one window.
- **Reusable diagram template**: configure the content used for every new diagram.
- **Synchronized template source**: track a template in iCloud Drive or another synchronized folder, detect newer external versions, and explicitly update the local hidden working copy.
- **Workspace Agent**: use a Pi-powered conversation beside the editor. The Agent reads and edits the workspace's `.drawio` files directly, validates the resulting XML, and reloads the active diagram.
- **Selection and Page scope**: a shape selection always takes precedence. Without a selection, target the current Page, every Page, or explicitly selected Pages.
- **Persistent conversations**: continue a task with follow-up instructions while Pi is working, stop the current run, or start a fresh conversation for the workspace.
- **Checkpoint rollback**: draw.ai snapshots workspace diagrams before each Agent run, restores invalid edits automatically, and lets you roll back the latest successful change.
- **Cross-platform packaging**: macOS, Windows, and Linux build configurations are included.

## Interface preview

All screenshots use fictional demo data and contain no real workspace, account, conversation, or business information.

### Unified workspace

Create and organize folders, standard `.drawio` files, and the default template without searching across separate locations.

![draw.ai unified diagram workspace](docs/images/workspace-overview.png)

### Workspace Agent

Submit editing requests beside the diagram, target a Page or selection, review changed files, and roll back the latest change when needed.

![draw.ai Workspace Agent](docs/images/workspace-agent.png)

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

## Using the Workspace Agent

The Workspace Agent requires the local Pi CLI (`pi`) to be installed and authenticated.
Pi is required only for Agent requests; the workspace, templates, and diagram editor continue to work locally without it.

1. Select a diagram workspace and open a `.drawio` file from the left sidebar.
2. Open the **Agent** tab in the right sidebar.
3. Select shapes to restrict the change to those shapes, or choose the current, all, or specific Page scope. When shapes are selected, selection scope takes precedence and the Page selector is disabled.
4. Enter a request. While Pi is working, additional messages are added to the same active task.
5. Answer any extension confirmation or selection dialog shown in the Agent panel before the run continues. The active diagram reloads after a successful edit.
6. Use the rollback button to restore the diagrams captured before the latest successful Agent run. Rollback is refused if a changed file has been edited again, preventing newer work from being overwritten.

Conversations are retained per workspace. The Agent can edit multiple Pages in the selected scope. It edits another diagram file only when the request explicitly names that file. Invalid draw.io XML is rejected and automatically restored from the pre-run checkpoint.

The current release intentionally provides one Agent surface beside **Format**. The former **Quick Edit** workflow, in-app provider/API-key settings, image attachment flow, and correction-memory UI are not part of this architecture. Authentication and model/provider configuration are handled by the user's Pi installation, or by the **Pi command** and **model** fields in the Agent settings dialog.

## Agent safety model

Each Agent run follows a file-based, recoverable workflow:

1. draw.ai saves the active editor state before handing the task to Pi.
2. Every `.drawio` file in the workspace is copied to a local pre-run checkpoint.
3. draw.ai starts or resumes a persistent Pi session (`pi --mode rpc`) with the workspace as its working directory. Pi runs with the permissions of the local user account; draw.ai surfaces Pi extension dialogs in the Agent panel for confirmation.
4. The request includes the active file plus the authoritative selection or Page context. Pi edits the `.drawio` files directly while progress, commands, and file activity stream into the Agent panel.
5. draw.ai compares the workspace with the checkpoint, rejects diagram-file deletion, validates every changed or created draw.io XML file, and reloads the active diagram.
6. Failed, interrupted, unsafe, or invalid runs are restored automatically. The latest successful run remains available for explicit rollback.

Pi does not provide a built-in sandbox, so diagram safety comes from draw.ai's checkpoint, validation, and rollback workflow rather than from an engine-side write restriction. Keep the workspace pointed at a dedicated diagram folder and review the Agent's activity while it runs.

## Templates and iCloud

The editable working template is stored as a hidden file managed by draw.ai. Importing or updating a template replaces that hidden working copy after confirmation. When the source template is stored in iCloud Drive, draw.ai records the source and checks whether it has changed before the template is used or managed; synchronization of the source file itself remains iCloud's responsibility.

## Privacy

Workspace and diagram editing are local by default. The Agent starts the locally installed Pi CLI only after the user submits a request. Pi receives the request, the permitted Page or selection context, and access to `.drawio` files inside the selected workspace; it may use model services according to the user's Pi configuration. Review the applicable data retention and privacy terms before use.

Agent conversation metadata and recovery checkpoints are stored in draw.ai's local application data, separately from the diagram workspace. They are not synchronized through the workspace's iCloud folder. Checkpoints contain local copies of workspace diagrams so that failed runs and the latest successful change can be restored.

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
