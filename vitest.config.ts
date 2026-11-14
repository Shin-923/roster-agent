import { defineConfig } from "vitest/config";

// vite.config.ts 는 화면(web/) 기준이라, 테스트는 프로젝트 루트 기준으로 따로 지정한다.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
