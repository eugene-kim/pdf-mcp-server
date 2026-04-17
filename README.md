# pdf-mcp-server

An MCP server to get Codex to understand PDFs in a consistent manner.

Codex (and other coding agents) don't have a reliable, built-in way to read PDFs. This server exposes a `read_pdf` tool that extracts both text (via `pdftotext`) and page images (via `pdftoppm`), so the agent always reads PDFs the same way instead of falling back to whatever it happens to try.

## Requirements

- Node.js
- `poppler` utilities (`pdftotext`, `pdftoppm`, `pdfinfo`) — install via `brew install poppler` on macOS

## Install

```
npm install
npm run build
```

## Usage

Register in your MCP client config, pointing at `dist/index.js`.
