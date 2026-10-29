import * as cheerio from "cheerio";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { ApiError } from "./envelope.js";

export type ParsedTable = { rows: string[][] };
export type ParsedDoc = {
  text: string;
  html: string;
  tables: ParsedTable[];
  filename: string;
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function tablesFromHtml(html: string): ParsedTable[] {
  const $ = cheerio.load(html);
  const tables: ParsedTable[] = [];
  $("table").each((_, table) => {
    const rows: string[][] = [];
    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells: string[] = [];
        $(tr)
          .find("th, td")
          .each((___, cell) => {
            cells.push($(cell).text().replace(/\s+/g, " ").trim());
          });
        if (cells.length) rows.push(cells);
      });
    if (rows.length) tables.push({ rows });
  });
  return tables;
}

function textFromHtml(html: string): string {
  const $ = cheerio.load(html);
  $("table").each((_, table) => {
    const rows: string[] = [];
    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells: string[] = [];
        $(tr)
          .find("th, td")
          .each((___, cell) => {
            cells.push($(cell).text().replace(/\s+/g, " ").trim());
          });
        if (cells.length) rows.push(cells.join(" | "));
      });
    $(table).replaceWith(`\n[TABLE]\n${rows.join("\n")}\n[/TABLE]\n`);
  });
  return $.root().text().replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function parseDocx(buf: Buffer, filename: string): Promise<ParsedDoc> {
  const r = await mammoth.convertToHtml({ buffer: buf });
  const html = r.value || "";
  return { html, text: textFromHtml(html), tables: tablesFromHtml(html), filename };
}

async function parseDoc(buf: Buffer, filename: string): Promise<ParsedDoc> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buf);
  const body = (doc.getBody() || "").trim();
  if (!body) throw new Error("empty .doc body");
  // Preserve tab-separated rows as pseudo-tables
  const tables: ParsedTable[] = [];
  const lines = body.split(/\r?\n/);
  let current: string[][] = [];
  for (const line of lines) {
    if (line.includes("\t")) {
      current.push(line.split("\t").map((c) => c.replace(/\s+/g, " ").trim()));
    } else if (current.length) {
      tables.push({ rows: current });
      current = [];
    }
  }
  if (current.length) tables.push({ rows: current });
  const text = body;
  return { html: `<pre>${body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))}</pre>`, text, tables, filename };
}

async function parseHtml(buf: Buffer, filename: string): Promise<ParsedDoc> {
  const html = buf.toString("utf8");
  return { html, text: textFromHtml(html), tables: tablesFromHtml(html), filename };
}

export async function parseUpload(file: Express.Multer.File): Promise<ParsedDoc> {
  const filename = file.originalname || "upload";
  const ext = extOf(filename);
  try {
    if (ext === "docx") return await parseDocx(file.buffer, filename);
    if (ext === "doc") return await parseDoc(file.buffer, filename);
    if (ext === "html" || ext === "htm") return await parseHtml(file.buffer, filename);
    throw new ApiError(400, "UNSUPPORTED_FILE", `Unsupported file type .${ext || "unknown"}. Use .docx, .doc or .html.`);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, "UNREADABLE_FILE", `Could not read "${filename}". Upload a valid Word or HTML file.`);
  }
}

/** Derive pack id from printed markers, else from the upload filename (sample_* → SAMPLE). */
export function extractInputId(texts: string[], filenames: string[]): string {
  const joined = texts.join("\n");
  const labeled = joined.match(/\b(?:input[_\s-]?id|pack\s*id|document\s*id)\s*[:=#]?\s*([A-Za-z0-9_-]+)/i);
  if (labeled) return labeled[1].toUpperCase();
  const bare = joined.match(/\b(SAMPLE|H\d{1,2})\b/);
  if (bare) return bare[1].toUpperCase();
  for (const name of filenames) {
    const base = name.replace(/\.[^.]+$/, "");
    if (/^sample\b/i.test(base) || /^sample[_-]/i.test(base)) return "SAMPLE";
    const h = base.match(/^(h\d{1,2})\b/i);
    if (h) return h[1].toUpperCase();
  }
  return "UNKNOWN";
}
