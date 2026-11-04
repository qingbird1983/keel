/**
 * engine kind 装配夹具（Phase 4 切片②）：
 * 本片只验证"engine 是一个独立 Cell 进程、能过装载门、能就绪"；
 * `engine.step` 通道与 ReAct 循环在切片④落地，本文件的 step 导出暂不被调用。
 */

export function step() {
  return { decision: { kind: "done", summary: "engine-stub" } };
}

/** 就绪后的私有状态面：测试用它证明本模块跑在子进程里（pid ≠ 宿主 pid）。 */
export function snapshot() {
  return { pid: process.pid, kind: "engine-stub" };
}
