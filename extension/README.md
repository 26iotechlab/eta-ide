# Eta IDE extension

The part of Eta IDE that lives inside the editor: the Agent panel on the right, the status bar button, the full-screen
agent tab, the built-in browser panel and the "import settings from VS Code or Cursor" command.

The agent itself (planning, tools, checks, models) is the Eta engine in [`../console`](../console). The extension starts
that engine and shows its page in the panel.

## Build

```
npm ci
node esbuild.js --production
```

This writes `dist/extension.js`. The Eta IDE build script ([`../build-eta.mjs`](../build-eta.mjs)) runs the same build
and puts the result into the IDE, so you normally do not build this folder on its own.

## Files

- `src/extension.ts`: panel, commands, engine start, settings import
- `src/browserPanel.ts`: the built-in browser panel
- `themes/`: the Eta Black colour theme
- `package.json`: commands, settings and views of the extension

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
