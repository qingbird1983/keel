/**
 * 策略插件 → HookBus 的装配链（Phase 2 切片④ 回填项 ①；[ADR-0012](../../../docs/adr/ADR-0012-policy-plugin-process-and-hook-op.md)）。
 *
 * 这段链干的事很窄，但每一件都对应一条不变量：
 * 1. **策略代码在自己的进程里**（`policy-main` 入口）：宿主只把 hook 入参发过去，
 *    除了入参它什么都看不见（契约 §3.3 那一行的字面要求；进程内 import 会当天落空）；
 * 2. **插话点冲突 = 装配期整份拒绝**：两份策略声明同一个 hook 时**什么都不起、什么都不注册**——
 *    "同名覆盖"等于让后一份悄悄吃掉前一份的否决权，那是静默改判；
 * 3. **只注册报关单声明过的 hook**：未申领的插话点不注册（无介入即无事件，`hooks.ts` 既有口径），
 *    名字不在四 hook 白名单内也不注册（内核白名单封闭，新增类型必须 ADR）；
 * 4. **时限不造第二套**：请求超时 = `HOOK_TIMEOUT_MS`（契约 §7 的同一个数），
 *    超时/抛错/舱退一律走内核既有 fallback 并落 `HOOK_VERDICT{fallback:true}`——**不新增错误码**；
 * 5. **策略舱不属于任何 run**：不调 `attachRun`，其进程退出不触发任何 run 的 abort（I2）。
 */

import { HOOK_TIMEOUT_MS, KeelError, type HookBus, type HookName } from "@keel/core";
import type { LoadedManifest } from "./assembler.js";
import { CELL_READY_TIMEOUT_MS } from "./wire-cell.js";
import { CellSupervisor, SupervisedCell } from "./supervisor.js";

/** 契约 §4.8 的封闭白名单（本文件唯一的"内核事实"复制，越界即拒）。 */
const HOOK_WHITELIST: readonly string[] = [
  "toolApproval",
  "stopAdvice",
  "retryAdvice",
  "budgetExhaustedChoice",
];

export interface PolicySpec {
  /** 已过五步校验的策略报关单（`kind:"policy"`，`hooks` 非空且 ⊆ 白名单由 schema 保证）。 */
  manifest: LoadedManifest;
  /** 策略模块路径（宿主配置给出——报关单里没有代码路径字段，声明不指定实现）。 */
  modulePath: string;
}

/** `ASSEMBLY_RECORDED.policies` 的条目（ADR-0012 决策 6：追加字段，旧账本仍可读）。 */
export interface PolicySummary {
  name: string;
  version: string;
  hooks: string[];
}

export interface PolicyBinding {
  summary: PolicySummary;
  cell: SupervisedCell;
}

export interface WirePoliciesParams {
  supervisor: CellSupervisor;
  bus: HookBus;
  specs: PolicySpec[];
  /** 策略舱的进程入口（`packages/cell-runtime/dist/policy-main.js`）。 */
  policyEntryPath: string;
  /** 插话请求超时（缺省 = 内核 HookBus 用的同一个契约默认值）。 */
  hookTimeoutMs?: number;
  readyTimeoutMs?: number;
}

/**
 * 起策略舱 → 探就绪 → **全部就绪之后**才按声明逐个注册；返回绑定（调用方负责在收束时 `drainAndReap`）。
 *
 * 次序是有意的：注册放在最后一步，于是"装配失败"必然意味着**总线上什么都没挂**——
 * 半途失败若只收进程而不收注册，剩下的就是一个指向已reaped舱的 handler（`HookBus` 没有也不该有
 * unregister，注册是装配期动作），下一次同总线的 run 会在它上面得到一条 `fallback:true`。
 * 06 稿 §3.1 要的是"整份拒绝"，这条次序才是它的完整形状：要么全挂上，要么一条都不挂。
 *
 * 任何一步失败都会把**已经起来的舱收干净**再原样抛出——装配失败不该留下半活的进程。
 */
export async function wirePolicies(p: WirePoliciesParams): Promise<PolicyBinding[]> {
  const claimed = new Map<string, string>(); // hook → 第一个声明它的插件名
  for (const spec of p.specs) {
    const name = spec.manifest.meta.name;
    if (spec.manifest.kind !== "policy") {
      throw new KeelError(
        "SCHED/MANIFEST-INVALID",
        `policy wiring needs kind:"policy" manifests, got "${spec.manifest.kind}" for ${name}`,
        { name, kind: spec.manifest.kind },
      );
    }
    for (const hook of spec.manifest.hooks) {
      if (!HOOK_WHITELIST.includes(hook)) {
        // schema 已在装配期挡过一层；这里是接线侧的自我防卫（内核白名单封闭 = I1/V6）
        throw new KeelError(
          "SCHED/MANIFEST-INVALID",
          `hook "${hook}" is not on the four-hook whitelist (contract §4.8); ${name} refused`,
          { name, hook, whitelist: HOOK_WHITELIST },
        );
      }
      const first = claimed.get(hook);
      if (first) {
        throw new KeelError(
          "SCHED/MANIFEST-INVALID",
          `two policies claim hook "${hook}" (${first} and ${name}): 整份拒绝——"同名覆盖"等于让后一份悄悄吃掉前一份的否决权`,
          { hook, first, second: name },
        );
      }
      claimed.set(hook, name);
    }
  }

  const hookTimeoutMs = p.hookTimeoutMs ?? HOOK_TIMEOUT_MS;
  const bindings: PolicyBinding[] = [];
  try {
    for (const spec of p.specs) {
      const cell = p.supervisor.spawnCell({
        manifest: spec.manifest,
        pluginPath: spec.modulePath,
        cellEntry: p.policyEntryPath,
        // 策略舱要知道"报关单申领了哪几个插话点"，好在装载期把导出集合钉死（两张皮不起舱）
        bootstrapExtra: { hooks: spec.manifest.hooks },
      });
      bindings.push({
        summary: {
          name: spec.manifest.meta.name,
          version: spec.manifest.meta.version,
          hooks: [...spec.manifest.hooks],
        },
        cell,
      });
      // 就绪凭据与能力舱同源：一次既有 op 的应答（ADR-0011），不为策略方向新增 op
      try {
        await cell.conn.request("cell.snapshot", {}, p.readyTimeoutMs ?? CELL_READY_TIMEOUT_MS);
      } catch (err) {
        const code =
          (err as { code?: unknown })?.code === "TRANSPORT/BADFRAME"
            ? "TRANSPORT/BADFRAME"
            : "TRANSPORT/TIMEOUT";
        throw new KeelError(code, "policy cell not ready: no reply to the readiness probe", {
          reason: "CELL_NOT_READY",
          policy: spec.manifest.meta.name,
          modulePath: spec.modulePath,
          disposed: true,
          cause: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 装配的最后一步：整批注册（此前任何失败都不会走到这里，总线保持原样）
    for (const b of bindings) {
      for (const hook of b.summary.hooks) {
        p.bus.register(hook as HookName, (input: unknown) =>
          // 帧载荷 = {hook, input}；轮号由内核 HOOK_CALLED 记账，宿主在 handler 边界拿不到，
          // 也不为它改内核签名（ADR-0012 实施注记）
          b.cell.conn.request("policy.hook", { hook, input }, hookTimeoutMs),
        );
      }
    }
  } catch (err) {
    await Promise.allSettled(bindings.map((b) => b.cell.drainAndReap()));
    throw err;
  }
  return bindings;
}
