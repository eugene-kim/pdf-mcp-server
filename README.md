# pdf-mcp-server

An MCP server to get Codex to understand PDFs in a consistent manner.

Codex (and other coding agents) don't have a reliable, built-in way to read PDFs. This server exposes a `read_pdf` tool that extracts both text (via `pdftotext`) and page images (via `pdftoppm`), so the agent always reads PDFs the same way instead of falling back to whatever it happens to try.

## Requirements

- Node.js
- `poppler` utilities (`pdftotext`, `pdftoppm`, `pdfinfo`)
  - macOS: `brew install poppler`
  - Ubuntu/Debian: `sudo apt-get install -y poppler-utils`

## Install

```
npm install
npm run build
```

## Usage

Register in your MCP client config, pointing at `dist/index.js`.

For Codex CLI:

```
codex mcp add pdf -- node /absolute/path/to/pdf-mcp-server/dist/index.js
```

This writes an `[mcp_servers.pdf]` entry into `~/.codex/config.toml`. Verify with `codex mcp list`.
