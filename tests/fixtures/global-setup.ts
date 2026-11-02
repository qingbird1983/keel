/**
 * vitest globalSetup —— "子进程只跑 dist"（[P-002 规则 4](../../.agents/pitfalls/P-002-集成测试装配接线四类错.md)）的唯一执行点。
 *
 * 为什么要挪到这里：切片② 门禁实测（`pnpm clean` 起全链），41 个测试文件各在 `beforeAll` 里
 * `execSync("pnpm build")`，并发 worker 互相抢同一批 `dist/` 产物 —— 其中一个拿到
 * `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`，整套验收**随机红**。构建本身没有并发语义，抢的是文件。
 *
 * 现在构建在主进程里跑一次再开 worker：仍然每次 `pnpm test` 都重建（src 与 dist 不会失步，
 * 这是 P-002 那条坑的原意），但竞争面消失。各测试文件里原先的构建调用随之删除。
 */
import { execFileSync } from "node:child_process";

export function setup(): void {
  execFileSync("pnpm", ["build"], { cwd: process.cwd(), stdio: "inherit", shell: true });
}

export function teardown(): void {
  // 无持久进程：各测试文件自己收束 Cell 与 Ledger（ADR-0009）
}
