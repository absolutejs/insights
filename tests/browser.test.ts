/**
 * The browser tracker's hand-over between page loads: what one page could
 * not send, the next page in the same tab sends, unless consent went away.
 */
import { describe, expect, test } from "bun:test";
import { createBrowserTracker, type BrowserEvent } from "../src/browser";

const memoryStorage = () => {
  const items = new Map<string, string>();

  return {
    getItem: (key: string) => items.get(key) ?? null,
    items,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
};

const leftOver: BrowserEvent[] = [
  { at: 1, name: "page.viewed", path: "/portal/projects", sessionId: "tab-1" },
];

describe("between page loads", () => {
  test("the next page sends what the last one queued, in the same session", async () => {
    const storage = memoryStorage();
    storage.setItem("absolute-insights-queue", JSON.stringify(leftOver));
    storage.setItem("absolute-insights-session", "tab-1");
    const sent: BrowserEvent[][] = [];
    const tracker = createBrowserTracker({
      enabled: () => true,
      storage,
      transport: async (batch) => {
        sent.push(batch);
      },
    });
    await tracker.flush();
    await tracker.stop();

    expect(tracker.sessionId).toBe("tab-1");
    expect(sent).toEqual([leftOver]);
    expect(storage.items.has("absolute-insights-queue")).toBe(false);
  });

  test("nothing left over is sent once consent is withdrawn", async () => {
    const storage = memoryStorage();
    storage.setItem("absolute-insights-queue", JSON.stringify(leftOver));
    const sent: BrowserEvent[][] = [];
    const tracker = createBrowserTracker({
      enabled: () => false,
      storage,
      transport: async (batch) => {
        sent.push(batch);
      },
    });
    await tracker.flush();

    expect(sent).toEqual([]);
    expect(storage.items.has("absolute-insights-queue")).toBe(false);
  });

  test("a corrupt copy is ignored", async () => {
    const storage = memoryStorage();
    storage.setItem("absolute-insights-queue", "{not json");
    const sent: BrowserEvent[][] = [];
    const tracker = createBrowserTracker({
      enabled: () => true,
      storage,
      transport: async (batch) => {
        sent.push(batch);
      },
    });
    await tracker.flush();

    expect(sent).toEqual([]);
  });
});
