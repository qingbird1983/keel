// 探针 1 的辅助模块：旧框架常见的"工具工厂"导出形状。
module.exports = {
  name: "extra-sum",
  schema: { from: "require" },
  handler: function (params) {
    return { tool: "extra-sum", doubled: params.n * 2 };
  },
};
