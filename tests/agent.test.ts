import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { decide, newState, start, type LlmClient } from "../server/agent";
import { openDb, participants } from "../server/db";
import { parseCsv } from "../server/sheet";
import type { SessionData } from "../server/tools";

/*
 * 실제 API 를 부르지 않는 가짜 모델.
 * 정해진 순서대로 「도구를 쓰겠다」는 응답을 돌려주고, 우리 코드가 받은 요청을 기록한다.
 * 확인하는 것: 도구 실행 · 결과 전달 형식, 쓰기 도구에서 멈추는지, 승인 · 거절 뒤 이어지는지.
 */
type Call = { name: string; input: Record<string, unknown> };
function fakeClient(turns: (Call[] | string)[]) {
  const seen: MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const client: LlmClient = {
    beta: {
      messages: {
        create: async (p) => {
          seen.push(structuredClone(p));
          const t = turns[i++] ?? "끝";
          const content =
            typeof t === "string"
              ? [{ type: "text", text: t }]
              : t.map((c, k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name: c.name, input: c.input }));
          return { content, stop_reason: typeof t === "string" ? "end_turn" : "tool_use" } as unknown as BetaMessage;
        },
      },
    },
  };
  return { client, seen };
}

const session = (): SessionData => ({ sheet: parseCsv(readFileSync("data/sample.csv", "utf8")), fixes: new Map(), skips: new Map() });
const MAP = { name: "set_column_mapping", input: { name: "성명", email: "이메일 주소", phone: "연락처", language: "통역 언어" } };
const FIXES: Call[] = [
  { name: "propose_skip", input: { row: 5, reason: "중복" } },
  { name: "propose_skip", input: { row: 6, reason: "이메일 없음" } },
  { name: "propose_skip", input: { row: 7, reason: "유선 번호" } },
  { name: "propose_fix", input: { row: 3, field: "email", value: "junho.lee@example.com", reason: "도메인 누락" } },
];

describe("agent loop", () => {
  it("도구를 실행하고, 모든 tool_use 에 결과를 한 메시지로 돌려준다", async () => {
    const { client, seen } = fakeClient([[{ name: "inspect_sheet", input: {} }, MAP], "요약"]);
    const st = await start(client, newState(), session(), "검증해 줘");
    expect(st.status).toBe("done");
    const second = seen[1].messages.at(-1)!;
    expect(second.role).toBe("user");
    const ids = (second.content as { tool_use_id: string }[]).map((b) => b.tool_use_id);
    expect(ids).toEqual(["tu_1_0", "tu_1_1"]);
  });

  it("쓰기 도구에서 멈추고, 승인 전에는 DB 가 비어 있다", async () => {
    const db = openDb(":memory:");
    const s = session();
    const { client } = fakeClient([[MAP], FIXES, [{ name: "validate_rows", input: {} }, { name: "apply_to_db", input: { summary: "4건 저장" } }], "4건 저장 완료"]);
    const st = await start(client, newState(), s, "검증 후 반영해 줘", db);
    expect(st.status).toBe("awaiting_approval");
    expect(st.pending?.partial).toHaveLength(1); // 같은 턴의 validate_rows 결과는 들고 있다
    expect(db.select().from(participants).all()).toHaveLength(0);

    const after = await decide(client, st, s, true, db);
    expect(after.status).toBe("done");
    expect(db.select().from(participants).all()).toHaveLength(4);
    expect(after.log.find((l) => l.kind === "approval")).toMatchObject({ decision: "approved" });
  });

  it("거절하면 DB 에 쓰지 않고, 거절 사실을 모델에게 전한다", async () => {
    const db = openDb(":memory:");
    const s = session();
    const { client, seen } = fakeClient([[MAP], FIXES, [{ name: "apply_to_db", input: { summary: "4건" } }], "반영하지 않았습니다"]);
    const st = await start(client, newState(), s, "반영해 줘", db);
    await decide(client, st, s, false, db);
    expect(db.select().from(participants).all()).toHaveLength(0);
    expect(JSON.stringify(seen.at(-1)!.messages.at(-1))).toContain("거절");
  });

  it("쓰기 도구를 두 번 요청하면 하나만 대기시키고 나머지는 오류로 돌려준다", async () => {
    const { client } = fakeClient([[{ name: "apply_to_db", input: { summary: "a" } }, { name: "apply_to_db", input: { summary: "b" } }]]);
    const st = await start(client, newState(), session(), "반영");
    expect(st.status).toBe("awaiting_approval");
    expect(st.pending?.partial[0]).toMatchObject({ is_error: true });
  });

  it("도구 호출이 끝없이 이어지면 상한에서 멈춘다", async () => {
    const { client } = fakeClient(Array.from({ length: 40 }, () => [{ name: "inspect_sheet", input: {} }]));
    const st = await start(client, newState(), session(), "검증");
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/턴/);
  });
});

describe("재생 모드", () => {
  it("키 없이도 승인 화면까지 가고, 승인하면 저장 · 이력이 남는다", async () => {
    const { replayClient } = await import("../server/replay");
    const { changes } = await import("../server/db");
    const db = openDb(":memory:");
    const s = session();
    const client = replayClient(0);
    const seenStatus: string[] = [];
    const st = newState();
    st.onChange = () => seenStatus.push(st.status);
    await start(client, st, s, "검증", db);
    expect(st.status).toBe("awaiting_approval");
    expect(seenStatus.filter((x) => x === "running").length).toBeGreaterThan(3); // 도구마다 화면에 알린다
    await decide(client, st, s, true, db);
    expect(st.status).toBe("done");
    expect(db.select().from(participants).all()).toHaveLength(4);
    expect(db.select().from(changes).all().length).toBeGreaterThan(0);
  });
});
