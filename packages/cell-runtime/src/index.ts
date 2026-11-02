/**
 * @keel/cell-runtime —— Cell 执行单元的进程体：一次 Agent Run 独占一个 OS 进程
 * （"水密隔舱"，ADR-0005）——舱内崩溃不级联，越界效果必有声明。
 *
 * 已落地（切片③④）：stdio JSON 行帧协议（契约 §3.1）/ Cell 进程体 + 私有工具表 /
 * EFFECT_DECLARED 发起端 / 迁移钩入口（A5，兼恢复挂载通道）/ 补偿动作分发
 * （compensation.exec）/ 快照索取面（cell.snapshot）。零运行时依赖。
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
  type CompensationExecInput,
  type CompensationHandler,
  type EffectDeclaration,
  type ToolExecResult,
} from "./cell.js";
