<div align="center">

# Eta IDE

**The open-source agentic IDE that plans, builds and tests every change.**

[Download](https://github.com/26iotechlab/eta-ide/releases/latest) · [Report a problem](https://github.com/26iotechlab/eta-ide/issues) · [26io.com](https://26io.com)

</div>

---

Eta IDE is an agentic IDE: a desktop code editor with an AI agent built in that does the work itself. Describe what you want in plain words. Eta plans the work,
edits your files, runs the terminal, and checks the result before it tells you it is done. You watch every step, and
you can undo any run with one click.

Eta works with AI models on your own computer, so your code can stay on your machine. You can also connect a model
from any major provider. There is no Eta account and no Eta subscription.

> **Version 0.1.0** · Windows 10 and 11, 64-bit · Apache License 2.0

## Why Eta IDE

Most AI coding tools write code and hope it works. Eta is built around one rule: **a change is not finished until it
has been checked.**

- **Verified work.** Eta checks syntax, runs your project's tests, opens web pages in a real browser to look for
  errors, and goes back to fix a failing command before it finishes. Anything it could not fix is reported plainly,
  never hidden behind a "done".
- **Safe by design.** A strict terminal policy blocks dangerous commands, asks you before risky ones, and keeps the
  agent inside your project folder. By default Eta also asks before it edits a file or runs a command; tick
  **Edit automatically** in the Agent panel if you want it to work without asking.
- **Private by default.** Run models on your own computer. No telemetry. Your code only leaves your machine if you
  choose a cloud model.
- **Your model, your choice.** Local models or any provider, switched in one place.

## Features

### The agent

- **Plans before it acts.** Eta writes a plan, can ask you to approve it, then works through it step by step, with
  every step shown live in the panel.
- **A team of specialists.** Behind one chat, separate roles plan, design the logic, write code, criticise, test and
  review, so a single model checks its own work from several angles.
- **16 ready-made agents** for common jobs: code review, debugging, test writing, refactoring, security audit,
  performance, documentation, release checks and more. Add your own as simple text files.
- **13 built-in skills**, from git commits and pull requests to web pages and Python testing.
- **Parallel runs.** Try several tasks at once, each in its own isolated copy of your project, then keep the results
  you like.
- **Project hooks.** Run your own checks before or after the agent edits a file, or before it is allowed to finish.

### Verification

- Syntax checks on every file the agent writes.
- Your project's own test suite, run before and after the change, so the agent never breaks what already worked.
- A real browser opens the web pages the agent builds and reports console errors and broken elements.
- A guard against made-up package names before anything is installed.
- Every run ends with an honest summary: what was done, what was checked, and what is still open.

### Terminal you can trust

- **Blocked:** wiping disks, system and registry changes, turning off security, downloading and running scripts,
  reading passwords or keys, and anything outside your project folder.
- **Needs your approval:** pushing code, publishing packages, deleting folders, installs for the whole computer, and
  stopping other programs.
- **Runs smoothly:** commands that would wait for typing are switched to their non-interactive form; dev servers run in
  the background so you can open your app; output is cleaned and shortened for the model.

### Safety net

- **One-click Undo** for every run. Before each task Eta saves a private snapshot of your project, kept apart from
  your own git history, branches and staged files.
- **Review and rewind:** after a run you can look at every changed block and undo just one block, or go back to the
  exact step after any file edit. Your state is saved first, so you can come forward again.
- **You approve file edits by default.** Eta shows the changed lines before it writes (turn on "Edit automatically" in the
  panel to skip the question).
- One chat history per project folder.

### Knowledge and research

- **Code search** across your workspace that answers with the exact file and line, fully on your computer.
- **Web search and deep research** through the sources you choose, with a shared cache and polite limits per site.
- Reads Word and Excel files, and understands images and screenshots (with a model that can see images).
- **MCP support** to connect external tools and data sources.

### Workspace

- **Live token meter:** tokens read and written, the speed, and how full the model's memory window is.
- **@-mentions:** type `@` in the message box to attach a file or folder of your project (`@src/app.js`).
- **Edit selected code (Ctrl+Alt+K):** describe the change, look at it as a diff, then apply or discard it.
- **Tab completion** (off by default, turn it on in settings): grey suggestions while you type. It pauses while the agent works.
- The agent also sees the file you have open, your cursor line and the errors your editor shows.
- **Update notice** in the panel when a new version is released. Nothing installs by itself.
- Clean black-and-white theme, designed for long sessions.
- Import your settings and keyboard shortcuts from your previous editor in one step.
- Full code editor with language support for Python, Go, C and C++, C#, Rust, JavaScript and TypeScript, and more.

## Results

With an open-source model on a normal home PC, the Eta agent solved **about 65 % of small coding tasks (hidden tests) where the earlier version solved 20 %**, and **68 % against 50 % for the same model used alone** (34 of 50 task runs against 25 of 50). Details, tables and honest limits: [BENCHMARKS.md](BENCHMARKS.md).

## Models

| Where the model runs | How |
|---|---|
| **On your computer** | The setup page looks at your hardware, recommends a model and downloads it. Or connect Ollama or LM Studio. |
| **On another computer** | Any OpenAI-compatible server, for example vLLM. |
| **Cloud providers** | Anthropic Claude, Google Gemini, OpenRouter, or any OpenAI-compatible API. You pay the provider directly. |

For agent work, use models of about **20B parameters or larger**. Smaller models are not reliable enough for
multi-step coding tasks.

## Install

1. Download **`EtaIDE-Setup-<version>-x64.exe`** from [Releases](https://github.com/26iotechlab/eta-ide/releases/latest).
2. Run it. Eta installs for your Windows user only; no administrator rights are needed.
3. Open Eta IDE, open a project folder, and choose a model in the Agent panel on the right.

The installer is not code-signed yet. If Windows shows "Windows protected your PC", click **More info**, then
**Run anyway**. Only download Eta IDE from this page or from [26io.com](https://26io.com).

## Privacy

- No telemetry and no usage tracking.
- With a local model, your code and prompts never leave your computer.
- With a cloud model, the agent's prompts go to that provider under their terms.
- Once a day Eta checks this page for a newer version. It sends a plain request and no personal data. Turn it off
  with `"updateCheck": false` in `%USERPROFILE%\.eta-ide\config.json`.

## Build from source

See [BUILDING.md](BUILDING.md).

## Support

- Problems and ideas: [GitHub Issues](https://github.com/26iotechlab/eta-ide/issues)
- Business and other questions: [26io.com/contact](https://26io.com/contact)

## License

Eta IDE is released under the [Apache License 2.0](LICENSE).
Copyright 2026 [26io Techlab](https://26io.com).

Eta IDE includes open-source components under their own licences; see [NOTICE](NOTICE).

## Use Eta inside Zed or JetBrains (ACP)

`console/acp.mjs` lets editors that speak the Agent Client Protocol (ACP, https://agentclientprotocol.com) use Eta as their agent. It is a small bridge: it talks ACP over stdin and stdout, and it sends the work to an Eta engine that is already running on this PC.

1. Start Eta first (the Eta IDE, or `node server.mjs` in `console`). The bridge looks for the engine at `http://127.0.0.1:8713`. If your engine uses another port, set `ETA_ENGINE_URL`, for example `http://127.0.0.1:8710`.
2. Zed: add this to `settings.json`:

   ```json
   "agent_servers": {
     "Eta": {
       "command": "node",
       "args": ["D:/eta-ide/project/console/acp.mjs"],
       "env": { "ETA_ENGINE_URL": "http://127.0.0.1:8713" }
     }
   }
   ```

3. JetBrains (AI Assistant, custom ACP agent): add an agent with the same command `node`, the same argument, and the same environment variable.

What works: new sessions (the editor's project folder becomes Eta's workspace), prompts, Eta's tool steps shown as tool calls, approval questions shown as the editor's Allow or Reject prompt, plan approval, and Stop (cancel). Plain questions are answered as chat. Not supported yet: loading old sessions, images, and editor-side MCP servers.

If the engine is not running, the editor shows the error "Eta engine not reachable". Test: `node console/test-acp.mjs` (uses a fake engine, no model).
