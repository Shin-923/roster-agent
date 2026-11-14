import ExcelJS from "exceljs";

export type Row = Record<string, string>;
export type Sheet = { columns: string[]; rows: Row[] };

/** 업로드된 파일(xlsx 또는 csv)을 「첫 줄 = 칸 이름」 표로 읽는다. 모든 값은 문자열로 맞춘다. */
export async function readSheet(buf: Buffer, filename: string): Promise<Sheet> {
  if (filename.toLowerCase().endsWith(".csv")) return parseCsv(buf.toString("utf8"));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { columns: [], rows: [] };
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = (r.values as unknown[]).slice(1).map((v) => cellText(v));
    grid.push(vals);
  });
  return fromGrid(grid);
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object" && "text" in (v as object)) return String((v as { text: unknown }).text).trim();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

// 따옴표 안의 쉼표 · 줄바꿈을 처리하는 최소 CSV 파서 (BOM 제거 포함)
export function parseCsv(text: string): Sheet {
  const src = text.replace(/^﻿/, "");
  const grid: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); grid.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); grid.push(row); }
  return fromGrid(grid.filter((r) => r.some((v) => v.trim() !== "")));
}

function fromGrid(grid: string[][]): Sheet {
  const [head = [], ...body] = grid;
  const columns = head.map((h) => h.trim());
  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? "").trim()])));
  return { columns, rows };
}
