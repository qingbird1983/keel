/**
 * 受治理写入句柄（R3，ADR-0018）——从 cell.ts 拆出，保持单文件体量。
 *
 * 句柄只做三件事：选定本调用的 effect、把写入请求交给宿主、把宿主签发的收据原样返回。
 * 真实 IO、路径检查、identity 与收据都在宿主；Cell 不直接写文件。
 */

import type { EffectReceipt } from "@keel/runtime-context";
import { ChannelError } from "./protocol.js";
import type { DeclaredEffectView } from "./governance.js";

/** 受治理写入入参：路径必须是绝对路径；content 按 UTF-8 写入。 */
export interface WorkspaceWriteInput {
  path: string;
  content: string;
  /** 多 effect 工具显式指定；单 effect 可省略（框架自动绑定）。 */
  effectId?: string;
}

/** 受治理写入结果：收据由宿主签发，Cell 只转发给业务使用。 */
export interface WorkspaceWriteResult {
  path: string;
  bytes: number;
  effectId: string;
  receipt: EffectReceipt;
}

/** Run 侧能力句柄：只有 create/overwrite，没有裸 fs。 */
export interface WorkspaceCapability {
  create(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult>;
  overwrite(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult>;
}

/** 句柄只需要这一个通道方法（避免 workspace↔cell 的运行时循环依赖）。 */
export interface WorkspaceChannelClient {
  workspaceWrite(req: {
    effectId: string;
    mode: "create" | "overwrite";
    path: string;
    content: string;
    toolCallId?: string;
  }): Promise<{ receipt: EffectReceipt; bytes: number }>;
}

/** 单 effect 自动绑定；多 effect 必须显式给 effectId（不猜）。 */
export function createWorkspaceCapability(
  client: WorkspaceChannelClient,
  effects: readonly DeclaredEffectView[],
  toolCallId?: string,
): WorkspaceCapability {
  const send = async (
    mode: "create" | "overwrite",
    input: WorkspaceWriteInput,
  ): Promise<WorkspaceWriteResult> => {
    const effectId = input.effectId ?? (effects.length === 1 ? effects[0].effectId : undefined);
    if (!effectId) {
      throw new ChannelError(
        "TRANSPORT/BADFRAME",
        effects.length === 0
          ? "workspace write requires a declared effect (manifest governance.effects)"
          : "workspace write requires effectId when multiple effects are declared",
        { declared: effects.map((e) => e.effectId) },
      );
    }
    if (!effects.some((e) => e.effectId === effectId)) {
      throw new ChannelError("TRANSPORT/BADFRAME", `unknown effectId: ${effectId}`, { effectId });
    }
    const r = await client.workspaceWrite({
      effectId,
      mode,
      path: input.path,
      content: input.content,
      ...(toolCallId ? { toolCallId } : {}),
    });
    return { path: input.path, bytes: r.bytes, effectId, receipt: r.receipt };
  };
  return {
    create: (input) => send("create", input),
    overwrite: (input) => send("overwrite", input),
  };
}
