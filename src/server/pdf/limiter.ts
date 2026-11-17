export type LimiterResult<T> = { busy: true } | { busy: false; value: T };

export type Limiter = {
  run<T>(task: () => Promise<T>): Promise<LimiterResult<T>>;
};

/**
 * At most `concurrency` tasks run at once; up to `maxQueue` more wait; anything beyond that
 * fails fast with `busy` (no unbounded queue, no unbounded memory). A task that throws still
 * frees its slot; the error is passed on to the caller.
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
    async run<T>(task: () => Promise<T>): Promise<LimiterResult<T>> {
      if (active >= concurrency) {
        if (waiting.length >= maxQueue) return { busy: true };
        await new Promise<void>((resolve) => waiting.push(resolve));
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
