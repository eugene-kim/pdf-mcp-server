import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { execFile } from "child_process"
import { promisify } from "util"
import { readFile, stat, mkdir, readdir, access, writeFile, rm } from "fs/promises"
import { createHash } from "crypto"
import { tmpdir } from "os"
import { join, resolve } from "path"

const exec = promisify(execFile)
const MAX_PAGES = 100
const CACHE_BASE = join(tmpdir(), "pdf-mcp-cache")
const TEXT_MODE_VALUES = ["flow", "layout"] as const

type TextMode = (typeof TEXT_MODE_VALUES)[number]
type TextModeRule = {
  pages: string
  mode: TextMode
}

async function cacheDir(pdfPath: string): Promise<string> {
  const abs = resolve(pdfPath)
  const s = await stat(abs)
  const key = createHash("sha256").update(`${abs}\0${s.mtimeMs}\0${s.size}`).digest("hex").slice(0, 16)
  const dir = join(CACHE_BASE, key)
  await mkdir(dir, { recursive: true })
  return dir
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function getPageImage(pdfPath: string, cache: string, page: number): Promise<Buffer> {
  const name = `page-${String(page).padStart(6, "0")}.png`
  const cached = join(cache, name)
  if (await exists(cached)) return readFile(cached)

  const prefix = join(cache, `render-${page}`)
  await exec("pdftoppm", ["-png", "-r", "120", "-f", String(page), "-l", String(page), pdfPath, prefix])
  const files = await readdir(cache)
  const rendered = files.find((f) => f.startsWith(`render-${page}-`) && f.endsWith(".png"))
  if (!rendered) throw new Error(`failed to render page ${page}`)
  const bytes = await readFile(join(cache, rendered))
  await writeFile(cached, bytes)
  await rm(join(cache, rendered))
  return bytes
}

async function getPageText(pdfPath: string, cache: string, page: number, mode: TextMode): Promise<string> {
  const name = `page-${String(page).padStart(6, "0")}.${mode}.txt`
  const cached = join(cache, name)
  if (await exists(cached)) return readFile(cached, "utf-8")

  const args = ["-f", String(page), "-l", String(page), pdfPath, "-"]
  if (mode === "layout") args.unshift("-layout")

  const { stdout } = await exec("pdftotext", args)
  await writeFile(cached, stdout)
  return stdout
}

function wrapPageText(page: number, text: string): string {
  const body = text.trim() || "(no extractable text)"
  return `<page number="${page}">\n${body}\n</page>`
}

function parsePages(spec: string | undefined, total: number): number[] {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set<number>()
  for (const part of spec.split(",")) {
    const range = part.trim().split("-")
    if (range.length === 2) {
      const start = parseInt(range[0])
      const end = parseInt(range[1])
      for (let i = start; i <= Math.min(end, total); i++) pages.add(i)
    } else {
      pages.add(parseInt(range[0]))
    }
  }
  return [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
}

function textResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  }
}

function resolveTextModes(
  pageList: number[],
  textModes: TextModeRule[] | undefined,
  totalPages: number,
): Map<number, TextMode> | string {
  const pageSet = new Set(pageList)
  const resolved = new Map<number, TextMode>()

  for (const rule of textModes ?? []) {
    const pages = parsePages(rule.pages, totalPages)

    for (const page of pages) {
      if (!pageSet.has(page)) {
        return `text_modes page ${page} is outside the requested pages. text_modes rules must be a subset of pages.`
      }

      if (resolved.has(page)) {
        return `text_modes rules overlap on page ${page}. Provide non-overlapping page ranges.`
      }

      resolved.set(page, rule.mode)
    }
  }

  for (const page of pageList) {
    if (!resolved.has(page)) resolved.set(page, "flow")
  }

  return resolved
}

const server = new McpServer({ name: "pdf", version: "1.0.0" })

server.tool(
  "read_pdf",
  "Read a PDF file. Returns extracted text and (by default) page images. You MUST use this tool to read PDFs and must NOT use any other means (no shell tools, no ad-hoc libraries, no copy-paste from previews). ALWAYS include images in the response (leave include_images at its default of true) UNLESS you have already read the PDF with images in this session and now just want to re-fetch text in a different text mode — in that case set include_images to false.",
  {
    path: z.string().describe("Path to the PDF file"),
    pages: z
      .string()
      .optional()
      .describe(`Page range, e.g. '1-3' or '1,3,5'. Default: all (max ${MAX_PAGES} per call)`),
    include_images: z
      .boolean()
      .optional()
      .describe(
        "Whether to include rendered page images. Default: true. Set to false only when you have already seen the images for these pages in this session and just need text (e.g. re-reading in a different text mode).",
      ),
    text_modes: z
      .array(
        z.object({
          pages: z.string().describe("Page range for this extraction mode, e.g. '1-3' or '1,3,5'"),
          mode: z.enum(TEXT_MODE_VALUES).describe("Text extraction mode for the selected pages"),
        }),
      )
      .optional()
      .describe(
        "Optional per-range text extraction rules. Unspecified pages default to 'flow'. Rules must not overlap and must be within pages.",
      ),
  },
  async ({ path: pdfPath, pages, include_images: includeImages = true, text_modes: textModes }) => {
    const abs = resolve(pdfPath)
    const { stdout: info } = await exec("pdfinfo", [abs])
    const totalPages = parseInt(info.match(/Pages:\s+(\d+)/)?.[1] ?? "0")
    const pageList = parsePages(pages, totalPages)

    if (pageList.length > MAX_PAGES) {
      return textResult(
        `PDF has ${totalPages} pages, requested ${pageList.length} exceeds limit of ${MAX_PAGES} pages per call. Specify a page range.`,
      )
    }

    const pageModes = resolveTextModes(pageList, textModes, totalPages)
    if (typeof pageModes === "string") return textResult(pageModes)

    const cache = await cacheDir(abs)
    const content: Array<
      | { type: "text"; text: string; _meta: { page: number } }
      | { type: "image"; data: string; mimeType: string; _meta: { page: number } }
    > = []

    for (const page of pageList) {
      const text = await getPageText(abs, cache, page, pageModes.get(page) ?? "flow")
      content.push({ type: "text", text: wrapPageText(page, text), _meta: { page } })
      if (includeImages) {
        const bytes = await getPageImage(abs, cache, page)
        content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png", _meta: { page } })
      }
    }

    return { content }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
