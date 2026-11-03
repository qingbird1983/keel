// R4 生命周期样例：setup 注册资源与动态工具；dispose 先于资源 effect 执行。
// 仅用于证明 setup/effect/dispose 的真实进程链路，不参与业务插件选型。
let lifecycle = { started: false, disposed: false, order: [] };

export function setup(ctx) {
  lifecycle = { started: true, disposed: false, order: [] };
  ctx.effect(() => {
    lifecycle.order.push("effect");
  });
  return ctx.tools.register({
    name: "dynamic_echo",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (params) => ({ echo: params.text }),
  });
}

export function dispose() {
  lifecycle.disposed = true;
  lifecycle.order.push("dispose");
}

export function snapshot() {
  return { ...lifecycle, order: [...lifecycle.order] };
}

export const tools = [
  {
    name: "noop",
    schema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ ok: true }),
  },
];
