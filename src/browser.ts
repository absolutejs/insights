/**
 * Browser events, batched. The tracker never decides who the person is
 * (the server does, from the session) and never sends anything while
 * `enabled()` is false, so it can sit behind the application's consent.
 */
export type BrowserEvent = {
  at: number;
  name: string;
  path: string;
  properties?: Record<string, string | number | boolean | null>;
  sessionId: string;
};

export type BrowserTrackerOptions = {
  /** Checked before anything is queued or sent: the person's consent. */
  enabled: () => boolean;
  flushIntervalMs?: number;
  maxBatch?: number;
  /** Delivers one batch (e.g. a typed client call). A failed batch is
   *  dropped, not retried: these events are a sample, never a ledger. */
  transport: (events: BrowserEvent[]) => Promise<unknown>;
};

const DEFAULT_FLUSH_MS = 10_000;
const DEFAULT_MAX_BATCH = 50;
const MAX_QUEUE = 500;

const newSessionId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const createBrowserTracker = ({
  enabled,
  flushIntervalMs = DEFAULT_FLUSH_MS,
  maxBatch = DEFAULT_MAX_BATCH,
  transport,
}: BrowserTrackerOptions) => {
  const sessionId = newSessionId();
  let queue: BrowserEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const flush = async () => {
    if (queue.length === 0) return;
    if (!enabled()) {
      queue = [];

      return;
    }
    const batch = queue.slice(0, maxBatch);
    queue = queue.slice(maxBatch);
    await transport(batch).catch(() => undefined);
  };

  const onHide = () => {
    if (document.visibilityState === "hidden") void flush();
  };

  const start = () => {
    if (timer !== null || typeof window === "undefined") return;
    timer = setInterval(() => void flush(), flushIntervalMs);
    document.addEventListener("visibilitychange", onHide);
  };

  /** Queues one event (dropped when not enabled). */
  const track = (name: string, properties?: BrowserEvent["properties"]) => {
    if (typeof window === "undefined" || !enabled()) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({
      at: Date.now(),
      name,
      path: window.location.pathname,
      ...(properties ? { properties } : {}),
      sessionId,
    });
    start();
    if (queue.length >= maxBatch) void flush();
  };

  const stop = async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onHide);
    await flush();
  };

  return { flush, sessionId, stop, track };
};

export type BrowserTracker = ReturnType<typeof createBrowserTracker>;
