# gaps: index.js

候选名：`legacy-index`（合成版本 0.0.0，转正时由作者改写）
观察到的工具：（无）
观察到的能力：（无）

## 缺项清单（这些是合成给不出来的东西，必须人工补）

- **TOOL_CALL_TIMEOUT_UNKNOWN** — resources.toolCallTimeoutMs=30000 取自宿主默认值：观察期看不出真实耗时需求，请人工确认
- **UNOBSERVABLE_NATIVE_IO** — 舱内原生 fetch / fs / 模型 SDK 直调不经内核通道，本候选对它们**没有**任何依据；需要这些能力请人工补声明（net.fetch/fs.* + allow 清单），并注意边界表 #4/#12 已改判 C 档

## 观察证据

- pass 1 run `observe-index-1`：终态 failed，9 条事件，屏障放弃=false
- pass 2 run `observe-index-2`：终态 failed，9 条事件，屏障放弃=false
