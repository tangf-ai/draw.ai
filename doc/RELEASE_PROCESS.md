# draw.ai release process

Public releases are produced only from repositories, signing identities, update feeds, and store accounts controlled by the draw.ai project.

## Preparation

1. Merge and push the required editor changes to the `editor` branch of `tangf-ai/draw.ai`.
2. Point the desktop `drawio` submodule at that committed editor revision.
3. Confirm the version in `drawio/VERSION` and run `npm run sync`.
4. Run `npm run generate-icons`, `npm test`, JavaScript syntax checks, JSON validation, and diff checks.
5. Complete Electron interaction QA for workspace, template update/conflict handling, AI settings, AI apply/rollback, and editor startup.

## Packaging checks

- Product name is `draw.ai`.
- App ID is `ai.draw.desktop` and macOS diagram UTI is `ai.draw.diagram`.
- Linux executable is `draw-ai`.
- All installer and application icons use the original draw.ai artwork.
- Updater points only to `tangf-ai/draw.ai`.
- `NOTICE`, `LICENSE`, and the independent-project disclaimer are included.
- `.drawio` files remain compatible with the upstream format.

For macOS, verify the final app with `codesign --verify --deep --strict` and the DMG with `hdiutil verify`. Inspect the packaged `app.asar` and `Info.plist`, then calculate and publish SHA-256 hashes for every artifact.

Unsigned artifacts may be generated for local testing, but they must be clearly marked and must not be represented as notarized or production-signed releases.
