# Upstream maintenance

draw.ai depends on two upstream projects while publishing its complete source from one repository:

| Layer | Upstream | draw.ai branch |
| --- | --- | --- |
| Desktop shell | `jgraph/drawio-desktop` | `tangf-ai/draw.ai:main` |
| Editor | `jgraph/drawio` | `tangf-ai/draw.ai:editor` |

The `main` branch records the exact editor revision through the `drawio` submodule. A release must point that submodule at a commit reachable from the `editor` branch; it must not depend on uncommitted submodule changes.

## Recommended remotes

In the desktop checkout, use `origin` for `tangf-ai/draw.ai` and `upstream` for `jgraph/drawio-desktop`. In the `drawio` submodule, use `origin` for the same draw.ai repository and `upstream` for `jgraph/drawio`.

Because both layers share one GitHub repository, always specify the intended branch when pushing:

```bash
git -C drawio push origin HEAD:editor
git push origin main
```

Fetch upstream changes explicitly and merge them on a maintenance branch. Never force-push an upstream synchronization over a released draw.ai branch.

## Update sequence

1. Fetch the desktop and editor upstream remotes.
2. Merge editor updates into the local editor maintenance branch and resolve conflicts around built-in AI integration.
3. Run the relevant checks and push the editor commit to `origin/editor`.
4. Update the desktop `drawio` submodule pointer to that pushed editor commit.
5. Merge desktop upstream updates and resolve shell conflicts around workspace, templates, AI configuration, user-data migration, and branding.
6. Run `npm test`, syntax checks, Electron interaction QA, and platform packaging checks.
7. Push the desktop commit to `origin/main` and publish signed artifacts only through project-controlled identities and update channels.

## Compatibility boundaries

Keep `.drawio` file compatibility, the `application/vnd.jgraph.mxfile` MIME type, upstream copyright notices, and Apache-2.0 attribution. Keep draw.ai's product name, logo, application identifiers, repository links, signing identities, and update feed independent.

Before every public release, verify that packaged metadata contains `draw.ai`, `ai.draw.desktop`, and the original draw.ai icon, while retaining upstream attribution in `NOTICE` and license files.
