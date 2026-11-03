/**
 * IsolationProvider —— ADR-0005 隔离后端薄接口（spawn / kill / alive / exitCode / onExit）。
 *
 * MVP 后端 = 本机 OS 进程（node child_process）；演进期容器后端按同接口接入，
 * 契约与账本事件不变。Cell 进程入口 = @keel/cell-runtime dist main.js，
 * bootstrap JSON 经 argv 传递（插件路径 / 工具超时）。
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Cell 进程控制面（Supervisor 持有；killed 分类以 killRequested 标记判定，不靠 exitCode 猜）。 */
export interface CellProcess {
  /** 帧通道输出（Host→Cell）。 */
  stdin: { write(chunk: string): unknown };
  /** 帧通道输入（Cell→Host；进程退出即流结束）。 */
  stdout: AsyncIterable<Uint8Array>;
  /** 诊断流（不入帧通道）。 */
  stderr: AsyncIterable<Uint8Array> | null;
  kill(): void;
  alive(): boolean;
  exitCode(): number | null;
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void;
}

export interface SpawnSpec {
  /** Cell 进程入口（@keel/cell-runtime dist main.js）。 */
  entryPath: string;
  /** bootstrap JSON（cell-runtime main.ts 契约）。 */
  bootstrap: string;
  /** 最小环境变量白名单（ADR-0019；缺省不继承宿主全量环境）。 */
  env?: NodeJS.ProcessEnv;
  /** 工作目录（通常 = 本 Run 工作区根；ADR-0019）。 */
  cwd?: string;
  /** 可选 Node 权限模型参数（纵深防御；不是沙箱）。 */
  nodePermissionArgs?: string[];
}

export interface IsolationProvider {
  spawn(spec: SpawnSpec): CellProcess;
}

/**
 * spawn 环境白名单（ADR-0019）：只保留运行必需的变量。
 * 显式排除 `NODE_OPTIONS`（可注入代码）、各类 `*_TOKEN/KEY/SECRET` 与业务变量。
 */
export function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set([
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && allow.has(k)) out[k] = v;
  }
  return out;
}

export class ProcessIsolationProvider implements IsolationProvider {
  spawn(spec: SpawnSpec): CellProcess {
    const args = [...(spec.nodePermissionArgs ?? []), spec.entryPath, spec.bootstrap];
    const child: ChildProcess = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    });
    let killRequested = false;
    const exitCbs: Array<(info: { code: number | null; signal: string | null }) => void> = [];
    child.on("exit", (code, signal) => {
      for (const cb of exitCbs) cb({ code, signal });
    });
    return {
      stdin: {
        write: (chunk: string) => child.stdin?.write(chunk),
      },
      stdout: child.stdout as AsyncIterable<Uint8Array>,
      stderr: (child.stderr as AsyncIterable<Uint8Array>) ?? null,
      kill(): void {
        killRequested = true;
        child.kill();
      },
      alive: () => child.exitCode === null && !killRequested,
      exitCode: () => child.exitCode,
      onExit(cb) {
        exitCbs.push(cb);
      },
    };
  }
}
