/**
 * 能力词表 → 运行期授权规则（ADR-0010 决策 6；切片①把封闭词表第一次接进运行期裁决）。
 *
 * 三条口径：
 * 1. **只编译有跨通道 op 的词表项**。`memory.backend` 这类没有运行期 op 的项不产出规则——
 *    声明不等于能力，避免"报了关就以为有权限"的假授权（manifest 稿 §5.2 注记）。
 * 2. **未声明 = 无规则 = 默认拒绝**（I4）：授权器对无匹配规则一律拒并落 `AUTH_DENIED`，
 *    所以本函数的输出直接就是策略的 allow 集合，不需要额外的"拒绝名单"。
 * 3. `allow` 限定符给了就逐条收窄（glob 原样交给授权器的资源匹配），没给则 `*`。
 *    `tool.invoke`（Core→Cell 方向的工具执行裁决）**不在这里产出**——那是宿主策略既有内容，
 *    本片不擅自扩权限面；新增的只是 Cell 可见面里那两个写入口的裁决依据。
 */

import type { AuthRule } from "@keel/core";
import type { LoadedManifest } from "./assembler.js";

/** 词表项 → 对应运行期 action（无对应 op 的项一律不列，见口径 1）。 */
const CAP_ACTIONS: Record<string, readonly string[]> = {
  "tool.provide": ["tool.register", "tool.remove"],
  // 切片⑤（ADR-0013 决策 6）：`model.adapter` 是**一项权威的两个入口**——能调模型就能流式调，
  // 所以编译出两条规则；不新开 cap（词表扩展须 ADR，且报关单字段零变更）。
  "model.adapter": ["model.invoke", "model.stream"],
  "net.fetch": ["net.fetch"],
  "fs.read": ["fs.read"],
  "fs.write": ["fs.write"],
};

/** 把 manifest 声明编译成授权规则（subject = 该 run 的授权主体，由宿主装配时确定）。 */
export function manifestAuthRules(manifest: LoadedManifest, subject: string): AuthRule[] {
  const out: AuthRule[] = [];
  for (const perm of manifest.permissions) {
    const actions = CAP_ACTIONS[perm.cap];
    if (!actions) continue;
    const resources = perm.allow && perm.allow.length > 0 ? perm.allow : ["*"];
    for (const action of actions) {
      for (const resource of resources) out.push({ subject, action, resource });
    }
  }
  return out;
}

/** 诊断面：词表里存在但当前无运行期 op 的项（装配审计与报告用，不产规则）。 */
export function capabilitysWithoutRuntimeOp(manifest: LoadedManifest): string[] {
  return manifest.permissions.map((p) => p.cap).filter((cap) => !CAP_ACTIONS[cap]);
}
