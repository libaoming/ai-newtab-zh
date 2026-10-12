import type Anthropic from "@anthropic-ai/sdk";
import { buildHistoryDigest, slugifyUrl } from "./history-digest";
import { OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isBlocked, normalizeBlockList } from "./site-filter";
import { DEFAULTS } from "./schemas";
import { STORAGE_KEYS, ensureAgent, ensureEnvironment, type HomepageModel } from "./setup";
import type {
  BrowserBridge,
  GetHistoryResult,
  GetPageHtmlResult,
  HomepageBuildResult,
  KVStore,
  PageRef,
  RunCallbacks,
  RunPhase,
} from "./types";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type CustomToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;

/** Callbacks with the optionality resolved, so call sites don't repeat `?.`. */
interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

/** How many times in a row a build reattaches to its session without seeing a new event. */
const MAX_STREAM_RECONNECTS = 8;

/** Files mount under this root no matter what path you ask for. Ask for it directly. */
const UPLOAD_ROOT = "/mnt/session/uploads";

export interface RunOptions {
  client: Anthropic;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  /**
   * Hosts the tools must never read. A getter is re-read before every tool call,
   * so a list saved mid-build applies to the rest of that build.
   */
  blockedSites?: string[] | (() => Promise<string[]>);
  /** Ignored when resuming: the session keeps the agent (and model) it started with. */
  model?: HomepageModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  /** Reattach to an existing session instead of creating one (e.g. after the host was killed mid-run). */
  resumeSessionId?: string;
  now?: Date;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { client, bridge, store, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };

  emit.phase("setup");
  const [agentId, environmentId] = await Promise.all([
    ensureAgent(client, store, opts.model),
    ensureEnvironment(client, store),
  ]);
  emit.log(`agent=${agentId} environment=${environmentId}`);

  let sessionId = opts.resumeSessionId;
  if (!sessionId) {
    emit.phase("session-create");
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      title: `Homepage ${(opts.now ?? new Date()).toISOString().slice(0, 10)}`,
    });
    sessionId = session.id;
    await store.set(STORAGE_KEYS.activeSessionId, sessionId);
  }
  emit.log(`session=${sessionId}`);

  // Persist upload IDs so cleanup can still find them after a reattach.
  const uploadedFileIds: string[] =
    (await store.get<string[]>(STORAGE_KEYS.uploadedFileIds)) ?? [];
  const rememberUpload = async (id: string) => {
    uploadedFileIds.push(id);
    await store.set(STORAGE_KEYS.uploadedFileIds, uploadedFileIds);
  };

  let finalMessage = "";

  /**
   * Every path out of here must send a result. An `agent.custom_tool_use` that
   * never receives one leaves the session idle forever — the single
   * unrecoverable bug in this design.
   */
  const dispatch = async (event: CustomToolUse): Promise<void> => {
    try {
      const blockedSites = normalizeBlockList(
        (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ?? DEFAULT_BLOCKED_SITES,
      );
      let result: GetHistoryResult | GetPageHtmlResult;
      switch (event.name) {
        case "getHistory":
          result = await runGetHistory(event, bridge, emit, blockedSites);
          break;
        case "getPageHtml":
          result = await runGetPageHtml(event, { client, bridge, sessionId: sessionId!, rememberUpload, emit, blockedSites });
          break;
        default:
          throw new Error(`Unknown custom tool: ${event.name}`);
      }

      await client.beta.sessions.events.send(sessionId!, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        ],
      });
    } catch (err) {
      emit.log(`tool ${event.name} failed: ${String(err)}`);
      await client.beta.sessions.events.send(sessionId!, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            is_error: true,
            content: [{ type: "text", text: String(err) }],
          },
        ],
      });
    }
  };

  const observe = (event: SessionEvent) => {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            finalMessage += block.text;
            emit.text(block.text);
          }
        }
        break;
      case "agent.thinking":
        emit.phase("thinking");
        break;
      case "agent.tool_use":
        emit.phase("analyzing", event.name);
        emit.log(`sandbox:${event.name}`);
        break;
      case "session.error":
        emit.log(`session.error: ${JSON.stringify(event)}`);
        break;
    }
  };

  try {
    const seen = new Set<string>();
    /** Tool calls answered by this run. The event list can lag a result we just sent. */
    const answeredHere = new Set<string>();
    const isTerminal = (event: SessionEvent) =>
      event.type === "session.status_terminated" ||
      (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action");
    const logTerminal = (event: SessionEvent) =>
      emit.log(event.type === "session.status_idle" ? `idle: ${event.stop_reason.type}` : "session terminated");

    // The stream can drop (a proxy closing an idle connection, a network blip) while
    // the session carries on server-side. Reattach instead of giving up: the event
    // log is the source of truth, so every pass replays it and resumes from there.
    let finished = false;
    /** Consecutive passes that saw no new event. A pass that made progress resets it. */
    let drops = 0;
    let lastError: unknown;
    /** The event list can lag a kickoff we just sent, exactly as it can a tool result. */
    let kickedOffHere = false;
    while (!finished) {
      if (signal?.aborted) throw new Error("aborted");
      if (drops > MAX_STREAM_RECONNECTS) {
        throw new Error(
          `Lost the connection to the agent session ${MAX_STREAM_RECONNECTS} times in a row; giving up.` +
            (lastError ? ` Last error: ${String(lastError)}` : ""),
        );
      }
      if (drops > 0) {
        emit.log(`stream dropped; reconnecting (${drops}/${MAX_STREAM_RECONNECTS})`);
        await abortableSleep(Math.min(1000 * drops, 5000), signal);
      }

      const seenBefore = seen.size;
      let stream: { controller?: AbortController } | undefined;
      try {
        // ---- Open the stream BEFORE anything else. It only delivers events emitted
        // ---- after it opens; send first and the early transitions are gone.
        const live = await client.beta.sessions.events.stream(sessionId, undefined, { signal });
        stream = live;

        // ---- Then replay history. Covers the gap before the stream attached, and
        // ---- is what makes a reattach lossless.
        const history: SessionEvent[] = [];
        for await (const event of client.beta.sessions.events.list(sessionId)) {
          history.push(event);
        }

        const answered = new Set(
          history
            .filter((e): e is Extract<SessionEvent, { type: "user.custom_tool_result" }> =>
              e.type === "user.custom_tool_result",
            )
            .map((e) => e.custom_tool_use_id),
        );

        for (const event of history) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          observe(event);
        }

        const terminal = history.find(isTerminal);
        if (terminal) {
          logTerminal(terminal);
          finished = true;
          break;
        }

        // Re-answer any tool call that was left hanging when the stream dropped.
        for (const event of history) {
          if (event.type === "agent.custom_tool_use" && !answered.has(event.id) && !answeredHere.has(event.id)) {
            emit.log(`re-answering orphaned tool call ${event.id}`);
            await dispatch(event);
            answeredHere.add(event.id);
          }
        }

        if (!kickedOffHere && !history.some((e) => e.type === "user.message")) {
          kickedOffHere = true;
          await client.beta.sessions.events.send(sessionId, {
            events: [
              {
                type: "user.message",
                content: [
                  {
                    type: "text",
                    text: buildKickoffMessage({
                      now: opts.now ?? new Date(),
                      userSystemPrompt: opts.userSystemPrompt,
                    }),
                  },
                ],
              },
            ],
          });
        }

        for await (const event of live) {
          if (signal?.aborted) throw new Error("aborted");

          // Live-preview events carry no `id` and are never terminal. They only
          // arrive if `event_deltas` was requested, but the stream union includes
          // them either way — reading `.id` off one would throw.
          if (event.type === "event_start" || event.type === "event_delta") continue;

          if (!seen.has(event.id)) {
            seen.add(event.id);
            observe(event);
            if (event.type === "agent.custom_tool_use") {
              await dispatch(event);
              answeredHere.add(event.id);
            }
          }

          // Terminal checks run for *every* event, including ones we've already
          // seen. `continue`-ing on a duplicate above would skip the terminal
          // event that arrived in the history fetch, and the loop would never end.
          if (isTerminal(event)) {
            logTerminal(event);
            finished = true;
            break;
          }
        }
        // Falling out of the stream without a terminal event means it was cut.
      } catch (err) {
        if (signal?.aborted) throw err;
        // A bad key, a deleted session, a rejected request: retrying cannot fix
        // these, and the API's own message is the useful one.
        if (!isRetryable(err)) throw err;
        lastError = err;
        emit.log(`stream error: ${String(err)}`);
      } finally {
        // Close this pass's stream whether it finished, dropped, or was never read.
        stream?.controller?.abort();
      }
      if (!finished) drops = seen.size > seenBefore ? 1 : drops + 1;
    }

    emit.phase("writing");
    const code = await collectDeliverable(client, sessionId, finalMessage, emit);
    emit.phase("done");
    return { code: code.code, sessionId, source: code.source };
  } finally {
    // Privacy: the event log holds every domain, title and page body we sent,
    // and uploads persist independently of the session. Delete both, always.
    emit.phase("cleanup");
    await Promise.allSettled(uploadedFileIds.map((id) => client.beta.files.delete(id)));
    await store.remove(STORAGE_KEYS.uploadedFileIds);
    if (sessionId) {
      await deleteSessionWhenSettled(client, sessionId).catch((err) =>
        emit.log(`session ${sessionId} was not deleted: ${String(err)}`),
      );
    }
    await store.remove(STORAGE_KEYS.activeSessionId);
  }
}

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

async function runGetHistory(
  event: CustomToolUse,
  bridge: BrowserBridge,
  emit: Emit,
  blockedSites: string[],
): Promise<GetHistoryResult> {
  const input = event.input as { daysToAnalyze?: number; maxResults?: number };
  const daysToAnalyze = input.daysToAnalyze ?? DEFAULTS.daysToAnalyze;
  const maxResults = input.maxResults ?? DEFAULTS.maxResults;

  emit.phase("history", `${daysToAnalyze}d`);
  const { sites, totalSitesSeen } = await bridge.getHistory({ daysToAnalyze, maxResults });
  const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
  // Blocked domains are dropped from the count too: the model is never told they exist.
  const digest = buildHistoryDigest(allowed, {
    daysToAnalyze,
    maxResults,
    totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
  });
  emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
  return digest;
}

async function runGetPageHtml(
  event: CustomToolUse,
  ctx: {
    client: Anthropic;
    bridge: BrowserBridge;
    sessionId: string;
    rememberUpload: (id: string) => Promise<void>;
    emit: Emit;
    blockedSites: string[];
  },
): Promise<GetPageHtmlResult> {
  const input = event.input as { urls: string[]; loadDelayMs?: number };
  ctx.emit.phase("scraping", `${input.urls.length} pages`);

  const allowed: string[] = [];
  const blocked: GetPageHtmlResult["failed"] = [];
  for (const url of input.urls) {
    // Match on the URL the browser will load; malformed URLs never reach the signed-in browser.
    if (isAllowedUrl(url, ctx.blockedSites)) allowed.push(url);
    else blocked.push({ url, reason: "blocked by the user's settings" });
  }

  // Skip the bridge entirely when nothing is left, so no scraper window opens.
  const { pages: loaded, failed } = allowed.length
    ? await ctx.bridge.getPageHtml({
        urls: allowed,
        loadDelayMs: input.loadDelayMs ?? DEFAULTS.loadDelayMs,
      })
    : { pages: [], failed: [] };

  // A redirect can land on a blocked host; drop what it read before anything is uploaded.
  const pages = loaded.filter((page) => {
    if (!page.finalUrl || isAllowedUrl(page.finalUrl, ctx.blockedSites)) return true;
    blocked.push({ url: page.url, reason: "blocked by the user's settings" });
    return false;
  });
  if (blocked.length) ctx.emit.log(`blocked: ${blocked.length} url(s)`);

  const refs: PageRef[] = [];
  const mountFailures = [...blocked, ...failed];

  for (const page of pages) {
    try {
      const filename = `${slugifyUrl(page.url)}_${refs.length}.html`;
      const upload = await ctx.client.beta.files.upload({
        file: new File([page.html], filename, { type: "text/html" }),
      });
      await ctx.rememberUpload(upload.id);

      // Mount mid-session, while the session idles awaiting this very result.
      // The API re-roots every mount under /mnt/session/uploads (see below).
      const resource = await ctx.client.beta.sessions.resources.add(ctx.sessionId, {
        type: "file",
        file_id: upload.id,
        mount_path: `${UPLOAD_ROOT}/pages/${filename}`,
      });

      refs.push({
        url: page.url,
        title: page.title,
        // The API re-roots every mount under /mnt/session/uploads. Report what it
        // resolved, not what we asked for, or the model greps a path that isn't there.
        mountPath: resource.mount_path,
        bytes: page.html.length,
      });
      ctx.emit.log(`mounted ${page.url} -> ${resource.mount_path} (${page.html.length}b)`);
    } catch (err) {
      mountFailures.push({ url: page.url, reason: `mount failed: ${String(err)}` });
    }
  }

  if (refs.length === 0 && mountFailures.length > 0 && blocked.length === 0) {
    throw new Error(
      `No pages could be mounted. Failures: ${mountFailures
        .map((f) => `${f.url} (${f.reason})`)
        .join("; ")}`,
    );
  }

  return { pages: refs, failed: mountFailures };
}

// ---------------------------------------------------------------------------
// deliverable retrieval
// ---------------------------------------------------------------------------

const CODE_FENCE = /```(?:tsx|jsx|ts|js|typescript|javascript)?\s*\n([\s\S]*?)```/;

/** 4xx responses are the caller's fault and will fail the same way again; 408 and 429 will not. */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true;
  return status < 400 || status >= 500 || status === 408 || status === 429;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Strip a ```tsx fence, if the model wrapped the file contents in one. */
function stripFence(text: string): string {
  const fenced = text.match(CODE_FENCE);
  return (fenced ? fenced[1] : text).trim();
}

async function collectDeliverable(
  client: Anthropic,
  sessionId: string,
  finalMessage: string,
  emit: Emit,
): Promise<{ code: string; source: HomepageBuildResult["source"] }> {
  // There is a short indexing lag between status_idle and outputs appearing.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      for await (const file of client.beta.files.list({
        scope_id: sessionId,
        betas: [MANAGED_AGENTS_BETA],
      })) {
        if (!/\.(tsx|jsx|ts|js)$/.test(file.filename)) continue;
        const response = await client.beta.files.download(file.id);
        const text = await response.text();
        if (text.trim()) {
          emit.log(`deliverable from session output: ${file.filename} (${text.length}b)`);
          return { code: stripFence(text), source: "session-output" };
        }
      }
    } catch (err) {
      emit.log(`files.list attempt ${attempt + 1} failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }

  // Fallback: the model sometimes answers with the component inline instead of
  // (or as well as) writing it. Better than failing the run outright.
  const fenced = finalMessage.match(CODE_FENCE);
  if (fenced && fenced[1].includes("PersonalizedHomepage")) {
    emit.log("deliverable recovered from message fence");
    return { code: fenced[1].trim(), source: "message-fence" };
  }

  throw new Error(
    `Agent produced no homepage. Expected a file at ${OUTPUT_PATH}. ` +
      `Final message: ${finalMessage.slice(0, 400)}`,
  );
}

/**
 * A running session can't be deleted ("cannot delete while running"). After a
 * normal finish that's only the brief lag between the stream's idle and the
 * queryable status. After a cancel or error the agent is still mid-turn, so it
 * gets interrupted and has to reach a safe boundary before it goes idle.
 */
const SETTLE_POLLS_BEFORE_INTERRUPT = 10;
const INTERRUPT_DEADLINE_MS = 60_000;

async function deleteSessionWhenSettled(client: Anthropic, sessionId: string): Promise<void> {
  const deadline = Date.now() + INTERRUPT_DEADLINE_MS;
  let interrupted = false;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const session = await client.beta.sessions.retrieve(sessionId);
    if (session.status !== "running") break;
    if (!interrupted && attempt >= SETTLE_POLLS_BEFORE_INTERRUPT) {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
      interrupted = true;
    }
    await new Promise((r) => setTimeout(r, interrupted ? 1000 : 200));
  }
  await client.beta.sessions.delete(sessionId);
}
