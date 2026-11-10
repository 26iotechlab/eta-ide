# Building Eta IDE

These steps produce the same program and installer as the official release. Windows 10 or 11, 64-bit.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [Inno Setup 6](https://jrsoftware.org/isinfo.php), for the installer
- [rcedit](https://github.com/electron/rcedit/releases) (`rcedit-x64.exe`), which sets the program icon and file
  details. Put it in `ide-patches\tools\`, or set the `RCEDIT` environment variable to its path.
- The editor base: the Windows x64 zip of [VSCodium](https://github.com/VSCodium/vscodium/releases), unzipped.
  Eta IDE 0.1.0 uses version 1.143.17232.

## Steps

```
cd console   && npm ci && cd ..
cd extension && npm ci && cd ..
node build-eta.mjs <unzipped editor base folder>    # writes build\Eta-IDE
node installer\make-installer.mjs                   # writes release\EtaIDE-Setup-<version>-x64.exe
```

`build-eta.mjs` copies the editor base, applies Eta's name, logo, theme and defaults, builds the extension from
`extension/src`, adds the Eta engine from `console/`, and stops with a clear message if any step does not apply.

## Run only the engine

```
cd console
npm ci
node server.mjs        # then open http://localhost:8710 (or set PORT)
npm test
```

## Project layout

| Folder | What it is |
|---|---|
| `console/` | The Eta engine: agent, tools, terminal policy, model hosting and the panel page (`ui.html`) |
| `console/engine/` | Eta Engine, the local model runner |
| `console/agents/`, `console/skills/` | The built-in agents and skills (plain text files) |
| `extension/` | The editor extension: Agent panel, commands and the Eta Black theme |
| `build-eta.mjs` | Turns the editor base into Eta IDE |
| `installer/` | The Windows installer script |
| `eta-layer/`, `brand/` | Logos, icons and third-party notices used by the build |

## Open-source components

Eta IDE is built on the open-source Code - OSS editor (MIT License, Microsoft), distributed as VSCodium, and its local
model runner is based on Colibri (Apache License 2.0). The full list of components and their licences is in
[NOTICE](NOTICE) and in `ThirdPartyNotices.txt` inside the installed program.
