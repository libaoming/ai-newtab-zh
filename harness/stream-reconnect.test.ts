import { describe, expect, test } from "bun:test";
import { runHomepageBuild } from "@homepage/agent-core";

type Ev = Record<string, any>;

/**
 * A scripted stand-in for the Managed Agents API. The session log advances when
 * the build sends events; each stream delivers what was logged after it opened,
 * and `cut(streamNo, delivered)` decides when that stream dies and how.
 */
function fakeApi(
  cut: (streamNo: number, delivered: number) => "end" | "throw" | null,
  {
    reachable = true,
    status,
    message = "network error",
    listLag = 0,
  }: { reachable?: boolean; status?: number; message?: string; listLag?: number } = {},
) {
  const log: Ev[] = [];
  const calls = { streams: 0, history: 0, pages: 0, kickoffs: 0, results: [] as string[] };
  let n = 0;
  let lists = 0;
  const push = (e: Ev) => log.push({ id: `ev_${n++}`, ...e });
  const idle = (type: string) => push({ type: "session.status_idle", stop_reason: { type } });

  const send = async (_id: string, body: { events: Ev[] }) => {
    for (const e of body.events) {
      push(e);
      if (e.type === "user.message") {
        calls.kickoffs++;
        push({ type: "agent.custom_tool_use", name: "getHistory", input: {} });
        idle("requires_action");
      } else if (e.type === "user.custom_tool_result") {
        calls.results.push(e.custom_tool_use_id);
        const call = log.find((x) => x.id === e.custom_tool_use_id)!;
        if (call.name === "getHistory") {
          push({ type: "agent.custom_tool_use", name: "getPageHtml", input: { urls: ["https://example.com/"] } });
          idle("requires_action");
        } else {
          push({ type: "agent.message", content: [{ type: "text", text: "done." }] });
          idle("end_turn");
        }
      }
    }
  };

  const stream = async () => {
    const streamNo = ++calls.streams;
    if (!reachable) throw Object.assign(new Error(message), status ? { status } : {});
    let cursor = log.length;
    return (async function* () {
      let delivered = 0;
      for (;;) {
        const verdict = cut(streamNo, delivered);
        if (verdict === "end") return;
        if (verdict === "throw") throw new Error("network error");
        if (cursor < log.length) {
          delivered++;
          yield log[cursor++];
        } else {
          await new Promise((r) => setTimeout(r, 1));
        }
      }
    })();
  };

  const client = {
    beta: {
      agents: { create: async () => ({ id: "agent_1", version: 1 }) },
      environments: {
        list: async function* () {},
        create: async () => ({ id: "env_1" }),
      },
      sessions: {
        create: async () => ({ id: "sesn_1" }),
        retrieve: async () => ({ status: "idle" }),
        delete: async () => ({}),
        events: { stream, send, list: async function* () { if (lists++ >= 1 && lists <= 1 + listLag) return; yield* [...log]; } },
        resources: { add: async (_s: string, r: Ev) => ({ mount_path: r.mount_path }) },
      },
      files: {
        upload: async () => ({ id: "file_1" }),
        delete: async () => ({}),
        list: async function* () { yield { id: "out_1", filename: "homepage.tsx" }; },
        download: async () => ({ text: async () => "export default function PersonalizedHomepage() {}" }),
      },
    },
  };

  const bridge = {
    getHistory: async () => { calls.history++; return { sites: [], totalSitesSeen: 0 }; },
    getPageHtml: async ({ urls }: { urls: string[] }) => {
      calls.pages++;
      return { pages: urls.map((url) => ({ url, finalUrl: url, title: "t", html: "<p>hi</p>" })), failed: [] };
    },
  };

  const kv = new Map<string, unknown>();
  const store = {
    get: async (k: string) => kv.get(k),
    set: async (k: string, v: unknown) => void kv.set(k, v),
    remove: async (k: string) => void kv.delete(k),
  };

  const logs: string[] = [];
  let narration = "";
  const run = () =>
    runHomepageBuild({
      client: client as any,
      bridge: bridge as any,
      store: store as any,
      blockedSites: [],
      callbacks: { onLog: (l) => logs.push(l), onText: (t) => (narration += t) },
    });
  return { run, calls, logs, narration: () => narration };
}

describe("event stream reconnect", () => {
  test("a stream that ends silently mid-build is reattached, not treated as finished", async () => {
    // Stream 1 delivers the kickoff, the getHistory call and its idle, then closes.
    // The getPageHtml call is recovered from the event list on reattach.
    const api = fakeApi((streamNo, delivered) => (streamNo === 1 && delivered >= 3 ? "end" : null));
    const result = await api.run();
    expect(result.code).toContain("PersonalizedHomepage");
    expect(api.calls.streams).toBe(2);
    expect(api.calls).toMatchObject({ kickoffs: 1, history: 1, pages: 1 });
    expect(api.logs.some((l) => l.startsWith("stream dropped; reconnecting"))).toBe(true);
    expect(api.logs).toContain("idle: end_turn");
  });

  test("a stream that throws a network error is reattached and nothing runs twice", async () => {
    const api = fakeApi((streamNo, delivered) => (streamNo === 1 && delivered >= 1 ? "throw" : null));
    const result = await api.run();
    expect(result.code).toContain("PersonalizedHomepage");
    expect(api.logs.some((l) => l.includes("network error"))).toBe(true);
    expect(api.calls).toMatchObject({ kickoffs: 1, history: 1, pages: 1 });
    expect(new Set(api.calls.results).size).toBe(api.calls.results.length);
    expect(api.narration()).toBe("done.");
  });

  test("an API that can never be reached fails with a clear message instead of hanging", async () => {
    const api = fakeApi(() => null, { reachable: false });
    await expect(api.run()).rejects.toThrow(/Lost the connection.*Last error: Error: network error/);
  }, 60_000);

  test("an error retrying cannot fix surfaces at once with the API's own message", async () => {
    const api = fakeApi(() => null, { reachable: false, status: 401, message: "invalid x-api-key" });
    await expect(api.run()).rejects.toThrow("invalid x-api-key");
    expect(api.calls.streams).toBe(1);
  });

  test("a connection that keeps dropping but keeps making progress is never given up on", async () => {
    // Every stream dies after a single event; the build still advances each pass.
    const api = fakeApi((_streamNo, delivered) => (delivered >= 1 ? "end" : null));
    const result = await api.run();
    expect(result.code).toContain("PersonalizedHomepage");
    expect(api.calls).toMatchObject({ kickoffs: 1, history: 1, pages: 1 });
  }, 60_000);

  test("a kickoff the event list has not caught up with is not sent twice", async () => {
    // Streams 1 and 2 close at once; the list call between them still shows an empty log.
    const api = fakeApi((streamNo) => (streamNo <= 2 ? "end" : null), { listLag: 1 });
    await api.run();
    expect(api.calls.kickoffs).toBe(1);
    expect(new Set(api.calls.results).size).toBe(api.calls.results.length);
  }, 60_000);
});
