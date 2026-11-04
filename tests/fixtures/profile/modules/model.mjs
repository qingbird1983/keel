/**
 * model kind 装配夹具（Phase 4 切片②）：
 * model 是宿主进程内模块——测试用 `__keelModelPid` 证明它与宿主同 pid。
 * 网关计价与 usage 分桶在切片③落地，这里只满足 `create() → ModelUpstream` 的导出面。
 */

const g = globalThis;
g.__keelModelModuleLoads = (g.__keelModelModuleLoads ?? 0) + 1;

export function create({ model, secrets }) {
  g.__keelModelPid = process.pid;
  g.__keelModelSecretRef = model.auth.ref;
  g.__keelModelSecretPresent =
    typeof secrets?.resolve === "function" && secrets.resolve(model.auth.ref) !== undefined;
  return {
    async invoke() {
      return {
        result: { mock: true },
        usage: { inputCached: 0, inputUncached: 1, output: 1 },
        cost: 0,
      };
    },
  };
}
