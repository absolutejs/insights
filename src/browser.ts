/**
 * Browser events, batched. The tracker never decides who the person is
 * (the server does, from the session) and never sends anything while
 * `enabled()` is false, so it can sit behind the application's consent.
 *
 * A full page load would drop whatever is still queued, so when the page
 * hides the queue is kept in the tab's session storage and the next page in
 * the same tab sends it. The tab's session id is kept there too: a reload
 * is the same session.
 */
export type BrowserEvent = {
  at: number;
  name: string;
  path: string;
  properties?: Record<string, string | number | boolean | null>;
  sessionId: string;
};

/** The part of the Web Storage API the tracker uses. */
export type TrackerStorage = {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
};

export type BrowserTrackerOptions = {
  /** Checked before anything is queued or sent: the person's consent. */
  enabled: () => boolean;
  flushIntervalMs?: number;
  maxBatch?: number;
  /** Where the queue and the tab's session id survive a page load. The
   *  tab's `sessionStorage` by default; `null` keeps everything in memory. */
  storage?: TrackerStorage | null;
  /** Delivers one batch (e.g. a typed client call). A failed batch is
   *  dropped, not retried: these events are a sample, never a ledger. */
  transport: (events: BrowserEvent[]) => Promise<unknown>;
};

const DEFAULT_FLUSH_MS = 10_000;
const DEFAULT_MAX_BATCH = 50;
const MAX_QUEUE = 500;
const QUEUE_KEY = "absolute-insights-queue";
const SESSION_KEY = "absolute-insights-session";

const newSessionId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const tabStorage = (): TrackerStorage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

const isEvent = (value: unknown): value is BrowserEvent => {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;

  return (
    typeof event.at === "number" &&
    typeof event.name === "string" &&
    typeof event.path === "string" &&
    typeof event.sessionId === "string"
  );
};

/* Storage can be full, disabled or blocked: the tracker carries on in
 * memory. */
const read = (storage: TrackerStorage | null, key: string) => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (storage: TrackerStorage | null, key: string, value: string) => {
  try {
    storage?.setItem(key, value);
  } catch {
    // Kept in memory only.
  }
};
const remove = (storage: TrackerStorage | null, key: string) => {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing kept to remove.
  }
};

const restoreQueue = (storage: TrackerStorage | null) => {
  const raw = read(storage, QUEUE_KEY);
  remove(storage, QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.filter(isEvent).slice(-MAX_QUEUE)
      : [];
  } catch {
    return [];
  }
};

export const createBrowserTracker = ({
  enabled,
  flushIntervalMs = DEFAULT_FLUSH_MS,
  maxBatch = DEFAULT_MAX_BATCH,
  storage = tabStorage(),
  transport,
}: BrowserTrackerOptions) => {
  const sessionId = read(storage, SESSION_KEY) ?? newSessionId();
  write(storage, SESSION_KEY, sessionId);
  /* Whatever the last page in this tab could not send, unless consent was
   * withdrawn since. */
  let queue: BrowserEvent[] = restoreQueue(storage);
  if (!enabled()) queue = [];
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

  /* The page is going away: keep what is queued for the next page in this
   * tab. */
  const keep = () => {
    if (queue.length === 0 || !enabled()) return;
    write(storage, QUEUE_KEY, JSON.stringify(queue));
  };
  /* Hidden (another tab, minimised, or leaving): keep a copy, and try to
   * send it now; a send that finishes clears the copy. */
  const onHide = () => {
    if (document.visibilityState !== "hidden") return;
    keep();
    void flush().then(() => {
      if (queue.length === 0) remove(storage, QUEUE_KEY);
    });
  };

  const start = () => {
    if (timer !== null || typeof window === "undefined") return;
    timer = setInterval(() => void flush(), flushIntervalMs);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", keep);
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
    if (typeof window !== "undefined")
      window.removeEventListener("pagehide", keep);
    await flush();
  };

  /* What the previous page left goes out on the first tick. */
  if (queue.length > 0) start();

  return { flush, sessionId, stop, track };
};

export type BrowserTracker = ReturnType<typeof createBrowserTracker>;
