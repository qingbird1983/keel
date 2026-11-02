# replay-multi-seg —— 段滚动跨文件样例

一个 Run 的 6 事件跨两段（seg-000001 seq 1~4 + seg-000002 seq 5~6，2026-11-02 切片⑤录制）。
断言点：跨段读取对调用方透明（`read` 一次返回全序）、seq 跨段连续、
`lastCheckpoint` 仍正确落在前段（seq 4 / round 1）。
