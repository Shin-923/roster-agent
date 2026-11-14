import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changes, openDb, participants, rollbackBatch } from "../server/db";
import { parseCsv } from "../server/sheet";
import { duplicates, normalizePhone, runTool, validate, type SessionData } from "../server/tools";

const load = (): SessionData => ({ sheet: parseCsv(readFileSync("data/sample.csv", "utf8")), fixes: new Map(), skips: new Map() });
const mapped = () => {
  const s = load();
  runTool("set_column_mapping", { name: "성명", email: "이메일 주소", phone: "연락처", language: "통역 언어" }, s);
  return s;
};

describe("normalizePhone", () => {
  it.each([
    ["01098765432", "010-9876-5432"],
    ["+82 10 5555 1212", "010-5555-1212"],
    ["010 7777 8888", "010-7777-8888"],
    ["02-123-4567", null], // 유선 번호는 휴대폰으로 보지 않는다
    ["", null],
  ])("%s → %s", (raw, want) => expect(normalizePhone(raw)).toBe(want));
});

describe("tools", () => {
  it("CSV 를 읽는다 (머리글 + 7행)", () => {
    const s = load();
    expect(s.sheet.columns).toContain("이메일 주소");
    expect(s.sheet.rows).toHaveLength(7);
  });

  it("없는 칸 이름으로 지정하면 거부한다", () => {
    const out = runTool("set_column_mapping", { name: "이름", email: "이메일 주소", phone: "연락처", language: "통역 언어" }, load());
    expect(out.ok).toBe(false);
  });

  it("문제를 찾는다: 이메일 형식, 빈 이메일, 유선 번호, 번호 형식 제안", () => {
    const issues = validate(mapped());
    const at = (row: number, field: string) => issues.filter((i) => i.row === row && i.field === field);
    expect(at(3, "email")[0].problem).toMatch(/형식/);
    expect(at(6, "email")[0].problem).toBe("비어 있음");
    expect(at(7, "phone")[0].problem).toMatch(/읽을 수 없음/);
    expect(at(4, "phone")[0].suggestion).toBe("010-5555-1212");
  });

  it("이메일 · 번호가 같은 행을 중복으로 묶는다", () => {
    const d = duplicates(mapped());
    expect(d.find((g) => g.key === "email:minji.kim@example.com")?.rows).toEqual([2, 5]);
  });

  it("남은 문제가 있으면 DB 에 쓰지 않는다", () => {
    const db = openDb(":memory:");
    const out = runTool("apply_to_db", { summary: "" }, mapped(), db);
    expect(out.ok).toBe(false);
    expect(db.select().from(participants).all()).toHaveLength(0);
  });

  it("고치고 뺀 뒤에는 정규화된 값으로 저장하고, 두 번 저장하지 않는다", () => {
    const db = openDb(":memory:");
    const s = mapped();
    runTool("propose_skip", { row: 5, reason: "2행과 중복" }, s);
    runTool("propose_skip", { row: 6, reason: "이메일 없음" }, s);
    runTool("propose_skip", { row: 7, reason: "휴대폰 번호 없음" }, s);
    runTool("propose_fix", { row: 3, field: "email", value: "junho.lee@example.com", reason: "도메인 누락(.com)" }, s);
    expect(validate(s).filter((i) => !i.suggestion)).toHaveLength(0);

    const out = runTool("apply_to_db", { summary: "4건 저장" }, s, db);
    expect(out.ok).toBe(true);
    const saved = db.select().from(participants).all();
    expect(saved).toHaveLength(4);
    expect(saved.find((r) => r.name === "박서연")?.phone).toBe("010-5555-1212");
    expect(runTool("apply_to_db", { summary: "" }, s, db).ok).toBe(false);
  });
  it("형식은 다 맞아도 중복이 남아 있으면 저장하지 않는다", () => {
    const db = openDb(":memory:");
    const s = mapped();
    runTool("propose_skip", { row: 6, reason: "이메일 없음" }, s);
    runTool("propose_skip", { row: 7, reason: "휴대폰 번호 없음" }, s);
    runTool("propose_fix", { row: 3, field: "email", value: "junho.lee@example.com", reason: "도메인 누락(.com)" }, s);
    expect(validate(s).filter((i) => !i.suggestion)).toHaveLength(0); // 형식 검사만으로는 통과
    const out = runTool("apply_to_db", { summary: "" }, s, db);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.data)).toContain("중복");
    expect(db.select().from(participants).all()).toHaveLength(0);
  });
  it("무엇을 바꾸고 뺐는지 이력으로 남기고, batch 단위로 되돌린다", () => {
    const db = openDb(":memory:");
    const s = mapped();
    runTool("propose_skip", { row: 5, reason: "2행과 중복" }, s);
    runTool("propose_skip", { row: 6, reason: "이메일 없음" }, s);
    runTool("propose_skip", { row: 7, reason: "휴대폰 번호 없음" }, s);
    runTool("propose_fix", { row: 3, field: "email", value: "junho.lee@example.com", reason: "도메인 누락(.com)" }, s);
    const out = runTool("apply_to_db", { summary: "" }, s, db);
    const batchId = (out.data as { batchId: string }).batchId;

    const log = db.select().from(changes).all();
    expect(log.find((c) => c.kind === "fix")).toMatchObject({ row: 3, field: "email", after: "junho.lee@example.com" });
    expect(log.find((c) => c.kind === "fix")?.before).not.toBe("junho.lee@example.com");
    expect(log.find((c) => c.kind === "normalize" && c.row === 4)).toMatchObject({ before: "+82 10 5555 1212", after: "010-5555-1212" });
    expect(log.filter((c) => c.kind === "skip").map((c) => c.row).sort()).toEqual([5, 6, 7]);

    expect(rollbackBatch(db, batchId)).toBe(4);
    expect(db.select().from(participants).all()).toHaveLength(0);
    expect(db.select().from(changes).all()).toHaveLength(0);
  });
});
