/**
 * 6-digit STAN allocator. Wraps at 999999, resets at midnight UTC. Process-local;
 * a multi-instance acquirer-host would need a Redis-backed allocator (Phase 6+).
 */
export interface StanAllocator {
  next(): string;
  /** Synthesize an RRN from the current time + STAN. */
  nextRrn(): { stan: string; rrn: string };
}

export function createStanAllocator(): StanAllocator {
  let counter = 0;
  let dayKey = utcDayKey();

  return {
    next() {
      const today = utcDayKey();
      if (today !== dayKey) {
        counter = 0;
        dayKey = today;
      }
      counter = (counter + 1) % 1_000_000;
      return counter.toString().padStart(6, '0');
    },
    nextRrn() {
      const stan = this.next();
      const now = new Date();
      const yDay = `${(now.getUTCFullYear() % 10).toString()}${String(dayOfYear(now)).padStart(3, '0')}`;
      const hms = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
      return { stan, rrn: `${yDay}${hms}${stan}` };
    },
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const diff = d.getTime() - start;
  return Math.floor(diff / 86_400_000);
}

function utcDayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
