// 探针 1 的懒加载模块：计数状态只在 require 它的那个进程里存在。
var hits = 0;

module.exports = {
  count: function (label) {
    hits += 1;
    return { label: label, hits: hits };
  },
};
