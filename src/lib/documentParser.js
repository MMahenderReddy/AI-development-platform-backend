/**
 * Document parser — converts uploaded files to plain text.
 *
 * Security rules enforced here:
 *  - PDF: text extraction only; embedded scripts and attachments are ignored
 *  - DOCX: converted to plain text via mammoth; macros are never executed
 *  - XLSX: cell values only; formulas are NOT evaluated
 *  - All formats: output is capped at MAX_CHARS before returning
 *
 * The returned text is treated as untrusted data. It is passed to the AI as
 * message content, never as instructions.
 */
import { readFile } from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

const MAX_CHARS = 500_000; // 500 KB of text — larger docs are chunked by the caller

/**
 * Returns { text: string, truncated: boolean }.
 * Throws if the file type is unsupported or the file cannot be read.
 */
export const parseDocument = async (filePath, mimeType) => {
  const ext = path.extname(filePath).toLowerCase();
  let text = "";

  if (mimeType === "application/pdf" || ext === ".pdf") {
    text = await parsePdf(filePath);
  } else if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    text = await parseDocx(filePath);
  } else if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === ".xlsx"
  ) {
    text = await parseXlsx(filePath);
  } else if (
    mimeType === "text/plain" || mimeType === "text/markdown" ||
    ext === ".txt" || ext === ".md"
  ) {
    text = await readFile(filePath, "utf8");
  } else {
    throw new Error(`Unsupported document type: ${mimeType ?? ext}`);
  }

  // Normalise whitespace — collapse runs of blank lines
  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (text.length > MAX_CHARS) {
    return { text: text.slice(0, MAX_CHARS), truncated: true };
  }
  return { text, truncated: false };
};

// ── Format handlers ──────────────────────────────────────────────────────────

const parsePdf = async (filePath) => {
  const buf = await readFile(filePath);
  // pdf-parse options: no rendering, no metadata expansion
  const data = await pdfParse(buf, { max: 0 });
  return data.text ?? "";
};

const parseDocx = async (filePath) => {
  // mammoth converts to raw text — macros are never read or executed
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages?.length) {
    const warnings = result.messages.filter((m) => m.type === "warning").map((m) => m.message);
    if (warnings.length) console.warn("[documentParser] DOCX warnings:", warnings.join("; "));
  }
  return result.value ?? "";
};

const parseXlsx = async (filePath) => {
  // Lazy-load exceljs only when needed (added in Phase 2)
  let ExcelJS;
  try {
    ({ default: ExcelJS } = await import("exceljs"));
  } catch {
    throw new Error("exceljs not installed — run: npm install exceljs");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const lines = [];
  workbook.eachSheet((sheet) => {
    lines.push(`## Sheet: ${sheet.name}`);
    sheet.eachRow((row) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        // Use cell.text which gives the display value — formulas are NOT evaluated
        const val = typeof cell.value === "object" && cell.value !== null
          ? (cell.value.result ?? cell.value.text ?? JSON.stringify(cell.value))
          : String(cell.value ?? "");
        if (val.trim()) cells.push(val.trim());
      });
      if (cells.length) lines.push(cells.join(" | "));
    });
    lines.push("");
  });
  return lines.join("\n");
};

/**
 * Split text into overlapping chunks for large-document processing.
 * Returns chunks of approximately `chunkChars` characters with `overlapChars` overlap.
 */
export const chunkText = (text, chunkChars = 6_000, overlapChars = 500) => {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkChars, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlapChars;
  }
  return chunks;
};
