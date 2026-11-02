/**
 * @keel/cell-runtime —— Cell 执行单元的进程体：一次 Agent Run 独占一个 OS 进程
 * （"水密隔舱"，ADR-0005）——舱内崩溃不级联，越界效果必有声明。
 *
 * 已落地（切片③）：stdio JSON 行帧协议（契约 §3.1）/ Cell 进程体 + 私有工具表 /
 * EFFECT_DECLARED 发起端 / 迁移钩入口（A5）。零运行时依赖。
 * 补偿执行与快照恢复随切片④（补偿状态机 + recover.*）接入。
 */

export {
  ChannelError,
  FrameConn,
  TRANSPORT_BADFRAME,
  TRANSPORT_TIMEOUT,
  type ConnStreams,
  type EventFrame,
  type FrameError,
  type RequestFrame,
  type ResponseFrame,
  toFrameError,
} from "./protocol.js";
export {
  startCell,
  type CellClient,
  type CellHandle,
  type CellOptions,
  type CellTool,
  type EffectDeclaration,
  type ToolExecResult,
} from "./cell.js";
