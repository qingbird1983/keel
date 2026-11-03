/**
 * 舱内端口（真实迁入路径）：旧 ctx 的注册动作在 **插件自己的进程**里发生，
 * 一次调用打通两半——Cell 私有执行表（能不能跑）+ Core scope 分区（能不能被看见）。
 *
 * 提交次序与回滚（02 稿 §5.2，ADR-0010 决策 3）：
 *   先写执行表 → 跨通道写内核 → **内核拒绝则回滚执行表**并把内核错误码原样抛出。
 *   反向（内核先行）会留下"可见但不可执行"的工具名：决策能选中它、执行必失败——
 *   那是本片禁止的静默形态。本地-first 的失败窗口是"可执行但不可见"，同一次调用内即回滚。
 *
 * 三条姿态：
 * - 版本由内核指派（`tool.register` 的返回值），承接层与插件都不自算（否则要本地记一张表）；
 * - `handler` 缺失的注册**直接拒绝**（`ADAPTER/HANDLER-REQUIRED`）：一个没有执行体的名字进可见表
 *   就是空壳形态，这里从源头堵掉；
 * - 撤名以内核为准：内核说"没有"，本地那条也撤掉——不留"可执行而不可见"的暗桩。
 *
 * 切片③加的另一半 = **改法地面**（`guide` 端口）：`ctx.model.invoke` / `ctx.effects.declare` /
 * `ctx.ledger.read` 三个面全部映射 `CellClient` 的**既有 op**（`model.invoke` / `effect.declare` /
 * `ledger.read`），承接层不加新 op、不加错误码、不改写归因——内核错误码原样浮出（04 稿 §2 F2）。
 * 作用域与主体由宿主在通道绑定上盖章，本进程给的任何 runId 都不参与裁决。
 */

import type { CellHandle, CellTool } from "@keel/cell-runtime";
import {
  buildCordisCtx,
  CordisAdapterError,
  type CordisCtx,
  type CordisEffectView,
  type CordisGuidePort,
  type CordisModelResult,
  type CordisRegistryPort,
} from "./core.js";

/**
 * 端口需要把旧 handler 包进执行表，而包装后的 handler 第二个参数要回注旧 ctx ——
 * ctx 与端口互相引用，故用延后绑定（注册动作必然发生在 ctx 构造完成之后）。
 */
export function createCordisCellCtx(cell: CellHandle): CordisCtx {
  let self: CordisCtx | null = null;

  const registry: CordisRegistryPort = {
    async register(name, schema, handler) {
      if (typeof handler !== "function") {
        throw new CordisAdapterError(
          "ADAPTER/HANDLER-REQUIRED",
          `tool "${name}" registered without a handler: Keel would show a name that cannot execute (静默降级的空壳形态)`,
        );
      }
      const prev = cell.getTool(name);
      const local: CellTool = {
        name,
        schema: schema ?? null,
        handler: (params) => handler(params, self as CordisCtx),
      };
      cell.registerTool(local); // 1. 本地占位（同名 = 覆盖）
      try {
        return await cell.client.registerTool(name, schema ?? null); // 2. 裁决 + 分区写 + 挂起变更
      } catch (err) {
        if (prev) cell.registerTool(prev);
        else cell.removeTool(name); // 3. 回滚：不留半个状态
        throw err;
      }
    },

    async remove(name) {
      const existed = await cell.client.removeTool(name); // 内核 = 单一事实源
      cell.removeTool(name); // 无论内核此前是否有名字，本地都不留暗桩
      return existed;
    },

    async list() {
      const rows = await cell.client.toolDiscover();
      return (rows as { name?: unknown; schemaVersion?: unknown }[]).map((t) => ({
        name: String(t.name),
        schemaVersion: Number(t.schemaVersion ?? 0),
      }));
    },
  };

  /**
   * 改法地面 = 既有通道 op 的直接映射，**没有一条是本地合成**：
   * - `effectId` 由 CellClient 指派（cell.ts 里 `crypto.randomUUID()`），承接层与插件都不填；
   * - 补偿动作与幂等口径不出现在这里——服务端按 manifest 报关单填（C-M1 焊点），
   *   插件能报关的只有"动了什么 kind、动了哪个目标、摘要是什么"。
   */
  const guide: CordisGuidePort = {
    async modelInvoke(reqId, req): Promise<CordisModelResult> {
      return (await cell.client.modelInvoke({
        reqId,
        model: req.model,
        params: req.params,
        estimate: req.estimate,
      })) as CordisModelResult;
    },
    async declareEffect(decl): Promise<CordisEffectView> {
      return cell.client.declareEffect({
        effectKind: decl.effectKind,
        compensation: decl.paramsDigest === undefined ? {} : { paramsDigest: decl.paramsDigest },
        ...(decl.targetSummary !== undefined ? { targetSummary: decl.targetSummary } : {}),
        ...(decl.dependsOn ? { dependsOn: decl.dependsOn } : {}),
        ...(decl.retention !== undefined ? { retention: decl.retention } : {}),
      });
    },
    async ledgerRead(filter) {
      // run 由宿主在通道绑定上强制覆盖（cell-server 的 ledger.read），这里传不出第二个 run
      return cell.client.ledgerRead(filter);
    },
  };

  const ctx = buildCordisCtx({ registry, guide });
  self = ctx;
  return ctx;
}
