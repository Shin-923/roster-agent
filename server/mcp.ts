import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { readSheet } from "./sheet.js";
import { runTool, type SessionData } from "./tools.js";

/*
 * 같은 검증 도구를 MCP 로 공개한다. Claude Desktop 같은 MCP 클라이언트가 이 도구를 쓸 수 있다.
 * 일부러 「읽기 전용」만 공개한다 — DB 쓰기는 사람 승인 화면이 있는 웹 앱에서만 한다.
 */

const server = new McpServer({ name: "roster-validator", version: "0.1.0" });

const mappingShape = {
  path: z.string().describe("검사할 xlsx 또는 csv 파일의 절대 경로"),
  name: z.string().describe("이름 칸의 원본 칸 이름"),
  email: z.string().describe("이메일 칸의 원본 칸 이름"),
  phone: z.string().describe("휴대폰 칸의 원본 칸 이름"),
  language: z.string().describe("통역 언어 칸의 원본 칸 이름"),
};

async function load(path: string): Promise<SessionData> {
  return { sheet: await readSheet(await readFile(path), basename(path)), fixes: new Map(), skips: new Map() };
}

const asText = (out: { ok: boolean; data: unknown }) => ({
  content: [{ type: "text" as const, text: JSON.stringify(out.data, null, 2) }],
  isError: !out.ok,
});

server.registerTool(
  "inspect_roster",
  { description: "명단 파일의 칸 이름 · 행 수 · 앞 5행 예시를 본다.", inputSchema: { path: mappingShape.path } },
  async ({ path }) => asText(runTool("inspect_sheet", {}, await load(path))),
);

server.registerTool(
  "validate_roster",
  { description: "칸을 지정해 빈 값 · 이메일 형식 · 휴대폰 번호 문제를 찾는다.", inputSchema: mappingShape },
  async ({ path, ...mapping }) => {
    const s = await load(path);
    const m = runTool("set_column_mapping", mapping, s);
    return asText(m.ok ? runTool("validate_rows", {}, s) : m);
  },
);

server.registerTool(
  "find_roster_duplicates",
  { description: "이메일 또는 휴대폰 번호가 같은 행 묶음을 찾는다.", inputSchema: mappingShape },
  async ({ path, ...mapping }) => {
    const s = await load(path);
    const m = runTool("set_column_mapping", mapping, s);
    return asText(m.ok ? runTool("find_duplicates", {}, s) : m);
  },
);

await server.connect(new StdioServerTransport());
