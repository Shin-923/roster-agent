import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { LlmClient } from "./agent.js";

/*
 * 재생 모드: API 키가 없을 때 실제 모델 대신 정해진 순서로 도구를 부른다.
 * 화면 · 승인 · 실시간 진행 흐름을 키 없이 확인하기 위한 것이고, data/sample.csv 기준으로 짜여 있다.
 * 판단은 하지 않는다 — 실제 판단은 ANTHROPIC_API_KEY 를 넣고 실행할 때 모델이 한다.
 */
type Step = { text?: string; calls?: { name: string; input: Record<string, unknown> }[] };

const SCRIPT: Step[] = [
  { text: "명단 구조부터 보겠습니다.", calls: [{ name: "inspect_sheet", input: {} }] },
  { calls: [{ name: "set_column_mapping", input: { name: "성명", email: "이메일 주소", phone: "연락처", language: "통역 언어" } }] },
  { calls: [{ name: "validate_rows", input: {} }, { name: "find_duplicates", input: {} }] },
  {
    text: "5행이 2행과 중복이고, 이메일 · 번호 문제가 3행 있습니다. 근거가 있는 것만 고치고 나머지는 뺍니다.",
    calls: [
      { name: "propose_skip", input: { row: 5, reason: "2행과 이메일 · 번호가 같음(중복)" } },
      { name: "propose_skip", input: { row: 6, reason: "이메일 없음, 원본에 근거 없음" } },
      { name: "propose_skip", input: { row: 7, reason: "유선 번호, 휴대폰 번호 없음" } },
      { name: "propose_fix", input: { row: 3, field: "email", value: "junho.lee@example.com", reason: "같은 도메인의 다른 행과 비교해 .com 누락으로 판단" } },
    ],
  },
  { calls: [{ name: "validate_rows", input: {} }, { name: "find_duplicates", input: {} }] },
  { calls: [{ name: "apply_to_db", input: { summary: "4건 저장 · 1건 수정 · 3건 제외 (번호 형식은 저장 때 맞춤)" } }] },
  { text: "4건을 저장했습니다. 3행 이메일을 고쳤고, 중복 · 이메일 없음 · 유선 번호 3행은 뺐습니다." },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function replayClient(delayMs = 600): LlmClient {
  return {
    beta: {
      messages: {
        create: async (p) => {
          await wait(delayMs);
          // 지금까지 assistant 가 몇 번 말했는지로 다음 차례를 정한다(승인 대기 뒤에도 이어진다).
          const step = SCRIPT[p.messages.filter((m) => m.role === "assistant").length] ?? { text: "끝났습니다." };
          const turn = p.messages.length;
          const content = [
            ...(step.text ? [{ type: "text", text: step.text }] : []),
            ...(step.calls ?? []).map((c, k) => ({ type: "tool_use", id: `rp_${turn}_${k}`, name: c.name, input: c.input })),
          ];
          return { content, stop_reason: step.calls?.length ? "tool_use" : "end_turn" } as unknown as BetaMessage;
        },
      },
    },
  };
}
