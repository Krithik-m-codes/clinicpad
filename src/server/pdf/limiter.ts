export type LimiterResult<T> = { busy: true } | { busy: false; aborted: true; value?: undefined } | { busy: false; aborted?: false; value: T };

export type Limiter = {
  run<T>(task: () => Promise<T>, opts?: { signal?: AbortSignal }): Promise<LimiterResult<T>>;
};

/**
 * At most `concurrency` tasks run at once; up to `maxQueue` more wait; anything beyond that
 * fails fast with `busy` (no unbounded queue, no unbounded memory). A task that throws still
 * frees its slot; the error is passed on to the caller. A queued task whose `signal` aborts leaves the queue
 * without running and without taking a slot. Each instance has its own limits (the public share route makes its own).
 */
export function createLimiter({ concurrency, maxQueue }: { concurrency: number; maxQueue: number }): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else active -= 1;
  };

  return {
    async run<T>(task: () => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<LimiterResult<T>> {
      const { signal } = opts;
      // The caller is gone (closed tab, cancelled request): do not take a slot for a result nobody will read.
      if (signal?.aborted) return { busy: false, aborted: true };
      if (active >= concurrency) {
        if (waiting.length >= maxQueue) return { busy: true };
        const admitted = await new Promise<boolean>((resolve) => {
          const onAbort = () => {
            const index = waiting.indexOf(admit);
            if (index >= 0) waiting.splice(index, 1);
            resolve(false);
          };
          const admit = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
          };
          waiting.push(admit);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        // A waiter removed by abort never received the slot, so there is nothing to release.
        if (!admitted) return { busy: false, aborted: true };
      } else {
        active += 1;
      }
      try {
        return { busy: false, value: await task() };
      } finally {
        release();
      }
    },
  };
}

/** Shared by every PDF render in this Node process. */
export const renderLimiter: Limiter = createLimiter({ concurrency: 2, maxQueue: 5 });
