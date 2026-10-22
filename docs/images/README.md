# AI interface previews

`ai-image-input.png`, `ai-conversation.png`, and `ai-selection-scope.png` are
captured from the real draw.io editor and current draw.ai assistant plugin.
They use an isolated temporary Electron profile, fictional messages, and a
pre-arranged diagram. No Pi process or model service is called. These images
demonstrate the interface, not end-to-end model quality or latency.

Regenerate from the repository root with an installed Electron runtime:

```bash
npx electron build/capture-ai-previews.mjs
```

The generator exercises the actual attachment picker/preview and selection
scope handlers. It does not read the user's workspace, Pi configuration, or
application profile. The screenshots themselves label the demo content.
