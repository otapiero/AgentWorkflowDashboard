type Schedule = (callback: () => void) => NodeJS.Immediate;
type Cancel = (handle: NodeJS.Immediate) => void;

/** Schedules activation work while making cancellation deterministic. */
export class DeferredActivation {
  private handle: NodeJS.Immediate | undefined;
  private generation = 0;
  private disposed = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });

  constructor(private readonly scheduleCallback: Schedule, private readonly cancelCallback: Cancel, private readonly start: () => void | Promise<void>) {}

  schedule(): void {
    const generation = ++this.generation;
    this.handle = this.scheduleCallback(() => {
      this.handle = undefined;
      if (this.disposed || generation !== this.generation) return;
      void Promise.resolve(this.start()).then(() => this.resolveReady(), error => this.rejectReady(error instanceof Error ? error : new Error(String(error))));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    if (this.handle) { this.cancelCallback(this.handle); this.handle = undefined; }
    this.rejectReady(new Error('activation cancelled'));
  }
}
