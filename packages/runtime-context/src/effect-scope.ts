/**
 * 资源 effect 栈（ADR-0017）——进程内清理，不是业务补偿。
 *
 * 语义对齐 Cordis 的 `ctx.effect`：注册的 disposer 按 LIFO 执行；dispose 幂等；
 * 单个 disposer 失败不阻断其余，全部结束后以 AggregateError 汇总。
 * 业务副作用（写文件、外发请求）必须走效果收据与补偿，不在这里“擦掉”。
 */

export type EffectDisposer = () => void | Promise<void>;

export class EffectScope {
  private readonly disposers: EffectDisposer[] = [];
  private disposing: Promise<void> | null = null;
  private disposed = false;

  /** 注册一个清理动作（同步或异步）；返回“提前移除”函数（已 dispose 时为空操作）。 */
  effect(disposer: EffectDisposer): () => void {
    if (this.disposed) {
      throw new Error("cannot register effect on a disposed scope");
    }
    this.disposers.push(disposer);
    return () => {
      const i = this.disposers.lastIndexOf(disposer);
      if (i >= 0) this.disposers.splice(i, 1);
    };
  }

  get size(): number {
    return this.disposers.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 逆序清理；重复调用返回同一个 promise（幂等）。 */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = this.runDisposers();
    return this.disposing;
  }

  private async runDisposers(): Promise<void> {
    const errors: unknown[] = [];
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop() as EffectDisposer;
      try {
        await fn();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} effect disposer(s) failed`);
    }
  }
}
