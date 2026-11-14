import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { randomUUID } from "node:crypto";
import { changes, participants, type ChangeInsert, type Db, type ParticipantInsert } from "./db.js";
import type { Sheet } from "./sheet.js";

/*
 * 에이전트가 쓸 수 있는 도구들.
 * - 모델은 「어떤 도구를 어떤 순서로 쓸지」만 고른다. 실제 판정 · 저장은 전부 이 파일의 코드가 한다.
 * - 쓰기 도구(apply_to_db)는 WRITE_TOOLS 에 넣어 두고, agent.ts 가 사람 승인 전에는 실행하지 않는다.
 */

export const FIELDS = ["name", "email", "phone", "language"] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Record<Field, string>;

export type Issue = { row: number; field: Field; problem: string; suggestion?: string };
export type Fix = { row: number; field: Field; value: string; reason: string };

export type SessionData = {
  sheet: Sheet;
  mapping?: Mapping;
  fixes: Map<string, Fix>; // key = `${row}:${field}`
  skips: Map<number, string>; // row → 사유
  appliedBatchId?: string;
};

export const WRITE_TOOLS = new Set(["apply_to_db"]);

/** 화면에 보이는 엑셀 행 번호(머리글이 1행이므로 데이터는 2행부터) */
const rowNo = (i: number) => i + 2;
const rowIdx = (n: number) => n - 2;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 한국 휴대폰 번호를 010-1234-5678 형태로. 바꿀 수 없으면 null */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("82")) d = "0" + d.slice(2);
  if (/^01[016789]\d{7,8}$/.test(d)) return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  return null;
}

/** 수정안을 반영한 i번째 행의 필드 값 */
function value(s: SessionData, i: number, f: Field): string {
  const fix = s.fixes.get(`${rowNo(i)}:${f}`);
  if (fix) return fix.value;
  const col = s.mapping?.[f];
  return col ? (s.sheet.rows[i]?.[col] ?? "").trim() : "";
}

export function validate(s: SessionData): Issue[] {
  const out: Issue[] = [];
  s.sheet.rows.forEach((_, i) => {
    const n = rowNo(i);
    if (s.skips.has(n)) return;
    for (const f of FIELDS) {
      const v = value(s, i, f);
      if (!v) { out.push({ row: n, field: f, problem: "비어 있음" }); continue; }
      if (f === "email" && !EMAIL.test(v)) out.push({ row: n, field: f, problem: `이메일 형식 아님: ${v}` });
      if (f === "phone") {
        const p = normalizePhone(v);
        if (!p) out.push({ row: n, field: f, problem: `휴대폰 번호로 읽을 수 없음: ${v}` });
        else if (p !== v) out.push({ row: n, field: f, problem: "형식이 표준과 다름", suggestion: p });
      }
    }
  });
  return out;
}

export function duplicates(s: SessionData): { key: string; rows: number[] }[] {
  const groups = new Map<string, number[]>();
  s.sheet.rows.forEach((_, i) => {
    const n = rowNo(i);
    if (s.skips.has(n)) return;
    const email = value(s, i, "email").toLowerCase();
    const phone = normalizePhone(value(s, i, "phone")) ?? "";
    for (const k of [email && `email:${email}`, phone && `phone:${phone}`]) {
      if (!k) continue;
      groups.set(k, [...(groups.get(k) ?? []), n]);
    }
  });
  return [...groups].filter(([, r]) => r.length > 1).map(([key, rows]) => ({ key, rows }));
}

// ── 모델에게 보여 줄 도구 정의 ─────────────────────────────────────────
const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object" as const, properties, required, additionalProperties: false });

export const toolDefs: BetaTool[] = [
  {
    name: "inspect_sheet",
    description: "업로드된 명단의 칸 이름, 행 수, 앞쪽 5행 예시를 본다. 가장 먼저 호출한다.",
    input_schema: obj({}, []),
  },
  {
    name: "set_column_mapping",
    description: "원본 칸 이름 중 무엇이 name(이름), email, phone(휴대폰), language(통역 언어)인지 지정한다. 칸 이름이 한국어 · 영어 무엇이든 의미로 판단한다.",
    input_schema: obj({ name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, language: { type: "string" } }, ["name", "email", "phone", "language"]),
  },
  {
    name: "validate_rows",
    description: "칸 지정 후 호출. 빈 값, 이메일 형식, 휴대폰 번호를 검사해 문제 목록을 돌려준다. suggestion 이 있으면 표준 형식 제안이다.",
    input_schema: obj({}, []),
  },
  {
    name: "find_duplicates",
    description: "이메일 또는 휴대폰 번호가 같은 행 묶음을 찾는다.",
    input_schema: obj({}, []),
  },
  {
    name: "propose_fix",
    description: "한 칸의 수정안을 기록한다. DB 에는 쓰지 않는다. 근거가 분명할 때만(예: 표준 형식 변환) 쓰고, 추측으로 값을 만들지 않는다.",
    input_schema: obj({ row: { type: "integer" }, field: { type: "string", enum: [...FIELDS] }, value: { type: "string" }, reason: { type: "string" } }, ["row", "field", "value", "reason"]),
  },
  {
    name: "propose_skip",
    description: "고칠 수 없는 행(중복 중 나중 행, 필수값 없음 등)을 반영 대상에서 뺀다. DB 에는 쓰지 않는다.",
    input_schema: obj({ row: { type: "integer" }, reason: { type: "string" } }, ["row", "reason"]),
  },
  {
    name: "apply_to_db",
    description: "수정안과 제외를 적용한 명단을 DB 에 저장한다. 사람이 승인해야 실행된다. 남은 문제가 0건일 때만 호출한다.",
    input_schema: obj({ summary: { type: "string", description: "사람에게 보여 줄 반영 요약 (몇 건 저장, 몇 건 수정, 몇 건 제외)" } }, ["summary"]),
  },
];

// ── 실행 ───────────────────────────────────────────────────────────
export type ToolOutput = { ok: boolean; data: unknown };

export function runTool(name: string, input: Record<string, unknown>, s: SessionData, db?: Db): ToolOutput {
  switch (name) {
    case "inspect_sheet":
      return { ok: true, data: { columns: s.sheet.columns, rowCount: s.sheet.rows.length, sample: s.sheet.rows.slice(0, 5) } };

    case "set_column_mapping": {
      const missing = FIELDS.filter((f) => !s.sheet.columns.includes(String(input[f])));
      if (missing.length) return { ok: false, data: `없는 칸 이름: ${missing.map((f) => `${f}=${input[f]}`).join(", ")}. 실제 칸: ${s.sheet.columns.join(", ")}` };
      s.mapping = Object.fromEntries(FIELDS.map((f) => [f, String(input[f])])) as Mapping;
      return { ok: true, data: s.mapping };
    }

    case "validate_rows": {
      if (!s.mapping) return { ok: false, data: "먼저 set_column_mapping 으로 칸을 지정하세요." };
      const issues = validate(s);
      return { ok: true, data: { issueCount: issues.length, issues: issues.slice(0, 80) } };
    }

    case "find_duplicates":
      if (!s.mapping) return { ok: false, data: "먼저 set_column_mapping 으로 칸을 지정하세요." };
      return { ok: true, data: duplicates(s) };

    case "propose_fix": {
      const row = Number(input.row), field = input.field as Field;
      if (!s.sheet.rows[rowIdx(row)]) return { ok: false, data: `${row}행은 없습니다.` };
      if (!FIELDS.includes(field)) return { ok: false, data: `알 수 없는 필드: ${field}` };
      s.fixes.set(`${row}:${field}`, { row, field, value: String(input.value), reason: String(input.reason) });
      return { ok: true, data: `${row}행 ${field} 수정안 기록` };
    }

    case "propose_skip": {
      const row = Number(input.row);
      if (!s.sheet.rows[rowIdx(row)]) return { ok: false, data: `${row}행은 없습니다.` };
      s.skips.set(row, String(input.reason));
      return { ok: true, data: `${row}행 제외 기록` };
    }

    case "apply_to_db": {
      if (!db) return { ok: false, data: "DB 연결 없음" };
      if (s.appliedBatchId) return { ok: false, data: `이미 반영됨 (batch ${s.appliedBatchId})` };
      // 승인 뒤라도 코드가 다시 검사한다 — 모델이 「문제 0건」이라고 말한 것을 그대로 믿지 않는다.
      // 형식 검사만이 아니라 중복도 다시 본다(모델이 중복 행을 빼먹어도 저장되지 않게).
      const remaining = validate(s).filter((i) => !i.suggestion);
      const dups = duplicates(s);
      if (remaining.length || dups.length)
        return { ok: false, data: { message: `남은 문제 ${remaining.length}건 · 중복 ${dups.length}묶음이 있어 저장하지 않았습니다.`, remaining: remaining.slice(0, 20), duplicates: dups } };
      const batchId = randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      const kept = s.sheet.rows.map((_, i) => i).filter((i) => !s.skips.has(rowNo(i)));
      const rows: ParticipantInsert[] = kept.map((i) => ({
        name: value(s, i, "name"),
        email: value(s, i, "email").toLowerCase(),
        phone: normalizePhone(value(s, i, "phone"))!,
        language: value(s, i, "language"),
        batchId,
        createdAt: now,
      }));
      const raw = (i: number, f: Field) => (s.mapping ? (s.sheet.rows[i]?.[s.mapping[f]] ?? "").trim() : "");
      const log: ChangeInsert[] = [
        ...[...s.fixes.values()].map((f) => ({ batchId, row: f.row, kind: "fix", field: f.field, before: raw(rowIdx(f.row), f.field), after: f.value, reason: f.reason, createdAt: now })),
        ...kept.flatMap((i) => {
          const before = value(s, i, "phone"), after = normalizePhone(before)!;
          return before === after ? [] : [{ batchId, row: rowNo(i), kind: "normalize", field: "phone", before, after, reason: "휴대폰 표준 형식", createdAt: now }];
        }),
        ...[...s.skips].map(([row, reason]) => ({ batchId, row, kind: "skip", field: null, before: null, after: null, reason, createdAt: now })),
      ];
      // 명단과 변경 이력은 함께 저장되거나 함께 실패한다.
      db.transaction((tx) => {
        if (rows.length) tx.insert(participants).values(rows).run();
        if (log.length) tx.insert(changes).values(log).run();
      });
      s.appliedBatchId = batchId;
      return { ok: true, data: { inserted: rows.length, skipped: s.skips.size, fixed: s.fixes.size, logged: log.length, batchId } };
    }
  }
  return { ok: false, data: `알 수 없는 도구: ${name}` };
}
