# replay-torn-tail —— 尾部撕裂负样例

末行 TOOL_INVOKE 半行撕裂（写入中断态固化，2026-11-02 切片⑤录制）。
断言点：冷实例读 = 止于最后完整行（seq 1~3 可读、撕裂行丢弃）、`lastCheckpoint` =
seq 3 / round 1——账本崩溃安全的格式层主张（ledger.test.ts 内联撕裂行为的录制对应物）。
