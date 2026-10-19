import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type Icon,
  type InputRequiredResult,
  type McpServer,
  type RegisteredTool,
  type ScopeChallengeHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import type { Call } from "../call.js";
import { SignatureGateError } from "../errors.js";
import type { SignatureGate, SignatureOutcome, SignedCall } from "../gate.js";
import type { JsonObject } from "../json.js";
import { normalizeShow } from "../show.js";

/** The `_meta` key on signed tools and on their results. */
export const SIGNATURE_META_KEY = "nexus.clavis/signature";

/** The key of the URL request in `inputRequests`. */
const INPUT_KEY = "nexus.clavis/signature";
const STATE_PREFIX = "nexus.clavis/signature:";
const DEFAULT_HOLD_SECONDS = 45;
/**
 * On a 2025-era connection the whole exchange rides one `tools/call`, which clients commonly time out after
 * 60 seconds. The wait for the signature gets what is left of this budget.
 */
const LEGACY_CALL_BUDGET_MS = 50_000;

export type SignedToolMessages = {
  /** Shown by the client next to the signature page's address. */
  request(show: string): string;
  /** 2025-era clients: the call ends while the signature is still awaited. */
  waiting(show: string, tool: string): string;
  /** Clients that cannot open a URL: the model passes the address on. */
  link(show: string, url: string, tool: string, expiresAt: Date): string;
  /** Clients that cannot open a URL, when `withoutUrlElicitation` is `"refuse"`. */
  unsupported(show: string): string;
  declined(show: string): string;
  expired(show: string, tool: string): string;
  noSigner(): string;
  /** The request could not be opened or read. `code` is Clavis's error code when there is one. */
  failed(code?: string): string;
};

const ENGLISH: SignedToolMessages = {
  request: (show) => `Sign with your passkey to run this: ${show}`,
  waiting: (show, tool) =>
    `Still waiting for the signature on “${show}”. Nothing has run. Once it is signed, call ${tool} again with the same arguments.`,
  link: (show, url, tool, expiresAt) =>
    `Signature required: “${show}”. Nothing has run. Ask the person to open ${url} and sign with their passkey before ${expiresAt.toISOString()}, then call ${tool} again with the same arguments.`,
  unsupported: (show) => `“${show}” needs the person's signature, and this client cannot open the signature page. Nothing has run.`,
  declined: (show) => `Not signed: “${show}”. Nothing has run.`,
  expired: (show, tool) =>
    `The signature request for “${show}” lapsed before it was signed. Nothing has run. Calling ${tool} again opens a new request.`,
  noSigner: () =>
    "This tool runs only after the signed-in person signs it, and no signed-in person comes with this request. Nothing has run.",
  failed: (code) => `The signature could not be requested${code ? ` (${code})` : ""}. Nothing has run.`,
};

export type RequireSignaturesOptions = {
  gate: SignatureGate;
  /**
   * The person behind this request, as your app knows them in Clavis (the OIDC `sub`, or the `sub` you kept
   * from linking their account). Return undefined when there is nobody to ask; the tool then does not run.
   */
  signer(ctx: ServerContext): string | undefined | Promise<string | undefined>;
  /** Seconds to wait for the signature in one round once the person has the page (45 by default). */
  holdSeconds?: number;
  /** The person's languages (BCP 47), so Connect matches the line you wrote. */
  uiLocales?(ctx: ServerContext): readonly string[] | undefined;
  /**
   * Where the call came from, bound into what is signed. By default the OAuth client and the resource of the
   * access token, when the request carries one.
   */
  context?(ctx: ServerContext): JsonObject | undefined;
  /**
   * When the client cannot open a URL: `"link"` (default) answers with the address for the model to pass on,
   * and the call runs when it comes back after the signature; `"refuse"` answers that the tool cannot run here.
   */
  withoutUrlElicitation?: "link" | "refuse";
  /**
   * If your server verifies `requestState` (`ServerOptions.requestState.verify`), pass the same codec so the
   * gate's state survives it. The state only tells the next round to keep waiting; it grants nothing.
   */
  requestState?: { mint(payload: unknown): Promise<string> };
  messages?: Partial<SignedToolMessages>;
  /** Errors that end a call without running it (Clavis unreachable, a line that cannot be shown, and so on). */
  onError?(error: unknown, info: { tool: string }): void;
};

type ToolArgs<InputArgs> = InputArgs extends StandardSchemaWithJSON
  ? StandardSchemaWithJSON.InferOutput<InputArgs>
  : Record<string, never>;

export type SignedToolConfig<InputArgs extends StandardSchemaWithJSON | undefined, OutputArgs extends StandardSchemaWithJSON> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  scopeChallenge?: ScopeChallengeHandler;
  _meta?: Record<string, unknown>;
  /**
   * The line the person reads before signing, from the call's arguments: what will happen, to what, in their
   * words. It becomes part of what they sign, so name everything the call changes.
   */
  show(args: ToolArgs<InputArgs>): string;
};

/** Runs after the signature, once per signature. `signature` is the record to keep with the operation. */
export type SignedToolHandler<InputArgs extends StandardSchemaWithJSON | undefined> = (
  args: ToolArgs<InputArgs>,
  ctx: ServerContext,
  signature: SignedCall,
) => CallToolResult | Promise<CallToolResult>;

export type SignedTools = {
  /** Same as `McpServer.registerTool`, plus `show`; the handler runs only after the person signs the call. */
  registerTool<OutputArgs extends StandardSchemaWithJSON, InputArgs extends StandardSchemaWithJSON | undefined = undefined>(
    name: string,
    config: SignedToolConfig<InputArgs, OutputArgs>,
    handler: SignedToolHandler<InputArgs>,
  ): RegisteredTool;
};

type RoundState = { phase: "requested" | "waiting"; at: number };

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Reads the gate's state from a verified payload or from the raw string; anything else is no state. */
function readRoundState(raw: unknown): RoundState | undefined {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.startsWith(STATE_PREFIX)) return undefined;
    try {
      payload = { [SIGNATURE_META_KEY]: JSON.parse(raw.slice(STATE_PREFIX.length)) as unknown };
    } catch {
      return undefined;
    }
  }
  const state = asRecord(asRecord(payload)?.[SIGNATURE_META_KEY]);
  if (!state) return undefined;
  if ((state.phase !== "requested" && state.phase !== "waiting") || typeof state.at !== "number") return undefined;
  return { phase: state.phase, at: state.at };
}

function supportsUrlElicitation(ctx: ServerContext, server: McpServer): boolean {
  const envelope = asRecord(ctx.mcpReq.envelope);
  // 2026-07-28 requests carry the client's capabilities; 2025-era connections declared them at initialize
  const capabilities = envelope ? envelope[CLIENT_CAPABILITIES_META_KEY] : server.server.getClientCapabilities();
  const elicitation = asRecord(asRecord(capabilities)?.elicitation);
  return elicitation !== undefined && "url" in elicitation;
}

function defaultContext(ctx: ServerContext): JsonObject | undefined {
  const auth = ctx.http?.authInfo;
  if (!auth) return undefined;
  const mcp: JsonObject = {};
  if (auth.clientId) mcp.client_id = auth.clientId;
  if (auth.resource) mcp.resource = auth.resource.href;
  return Object.keys(mcp).length > 0 ? { mcp } : undefined;
}

/** Our code, or Clavis's (`register_failed` carries it as `apiError`, e.g. `SIGNATURE_CEILING`). Never a message. */
function errorCode(error: unknown): string | undefined {
  if (error instanceof SignatureGateError) return error.code;
  const apiError = (error as { apiError?: unknown } | null)?.apiError;
  return typeof apiError === "string" ? apiError : undefined;
}

function withSignatureMeta(result: CallToolResult, meta: JsonObject): CallToolResult {
  return { ...result, _meta: { ...(result._meta ?? {}), [SIGNATURE_META_KEY]: meta } };
}

function notRun(text: string, meta: JsonObject): CallToolResult {
  return { content: [{ type: "text", text }], isError: true, _meta: { [SIGNATURE_META_KEY]: meta } };
}

/**
 * Tools on `server` that run only after the person signs the call with their passkey on Clavis.
 *
 * ```ts
 * const signed = requireSignatures(server, { gate, signer: (ctx) => clavisIdOf(ctx) });
 * signed.registerTool("refund", {
 *   inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
 *   show: ({ orderId, amount }) => `Refund $${amount} on order ${orderId}`,
 * }, async (args, ctx, signature) => { ... });
 * ```
 */
export function requireSignatures(server: McpServer, options: RequireSignaturesOptions): SignedTools {
  const holdSeconds = options.holdSeconds ?? DEFAULT_HOLD_SECONDS;
  if (!Number.isFinite(holdSeconds) || holdSeconds < 0) {
    throw new SignatureGateError("invalid_options", "holdSeconds must be zero or more");
  }
  const messages: SignedToolMessages = { ...ENGLISH, ...options.messages };
  const withoutUrlElicitation = options.withoutUrlElicitation ?? "link";
  const contextOf = options.context ?? defaultContext;

  async function roundState(state: RoundState): Promise<string> {
    const payload = { [SIGNATURE_META_KEY]: state };
    if (options.requestState) return options.requestState.mint(payload);
    return `${STATE_PREFIX}${JSON.stringify(state)}`;
  }

  function report(error: unknown, tool: string): void {
    try {
      options.onError?.(error, { tool });
    } catch {
      // A failing reporter must not turn into a run
    }
  }

  async function awaitingAnswer(
    tool: string,
    ctx: ServerContext,
    outcome: Extract<SignatureOutcome, { state: "awaiting" }>,
    continuing: boolean,
    round: RoundState | undefined,
  ): Promise<CallToolResult | InputRequiredResult> {
    const meta: JsonObject = { state: "awaiting", url: outcome.url, expires_at: outcome.expiresAt };
    if (!supportsUrlElicitation(ctx, server)) {
      if (withoutUrlElicitation === "refuse") return notRun(messages.unsupported(outcome.show), { state: "unsupported" });
      return notRun(messages.link(outcome.show, outcome.url, tool, new Date(outcome.expiresAt * 1000)), meta);
    }
    const modern = ctx.mcpReq.envelope !== undefined;
    if (continuing && !outcome.fresh) {
      // The person has the page. A 2026-07-28 client retries at once with the state alone: no prompt, just more waiting.
      if (modern) return inputRequired({ requestState: await roundState({ phase: "waiting", at: Date.now() }) });
      return notRun(messages.waiting(outcome.show, tool), meta);
    }
    return inputRequired({
      inputRequests: { [INPUT_KEY]: inputRequired.elicitUrl({ message: messages.request(outcome.show), url: outcome.url }) },
      // On a 2025-era connection the shim re-enters within the same call; the time it started bounds the wait
      requestState: await roundState({ phase: "requested", at: round?.phase === "requested" ? round.at : Date.now() }),
    });
  }

  function holdFor(ctx: ServerContext, continuing: boolean, round: RoundState | undefined): number {
    if (!continuing) return 0;
    const hold = holdSeconds * 1000;
    if (ctx.mcpReq.envelope !== undefined || round?.phase !== "requested") return hold;
    return Math.max(0, Math.min(hold, LEGACY_CALL_BUDGET_MS - (Date.now() - round.at)));
  }

  async function run<InputArgs extends StandardSchemaWithJSON | undefined>(
    tool: string,
    config: SignedToolConfig<InputArgs, StandardSchemaWithJSON>,
    handler: SignedToolHandler<InputArgs>,
    args: ToolArgs<InputArgs>,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    let call: Call;
    try {
      const signer = await options.signer(ctx);
      if (!signer) return notRun(messages.noSigner(), { state: "no_signer" });
      const context = contextOf(ctx);
      const uiLocales = options.uiLocales?.(ctx);
      call = {
        name: tool,
        arguments: args as JsonObject,
        show: config.show(args),
        signer,
        ...(context !== undefined ? { context } : {}),
        ...(uiLocales !== undefined ? { uiLocales } : {}),
      };
    } catch (e) {
      report(e, tool);
      return notRun(messages.failed(), { state: "failed" });
    }
    const show = normalizeShow(call.show) ?? call.show;

    const response = inputResponse(ctx.mcpReq.inputResponses, INPUT_KEY);
    if (response.kind === "elicit" && response.action !== "accept") {
      await options.gate.forget(call).catch((e: unknown) => report(e, tool));
      return notRun(messages.declined(show), { state: "declined" });
    }
    const round = readRoundState(ctx.mcpReq.requestState());
    const continuing = response.kind === "elicit" || round !== undefined;

    let outcome: SignatureOutcome;
    try {
      outcome = await options.gate.signatureFor(call, {
        holdMs: holdFor(ctx, continuing, round),
        signal: ctx.mcpReq.signal,
      });
    } catch (e) {
      if (ctx.mcpReq.signal.aborted) throw e;
      report(e, tool);
      return notRun(messages.failed(errorCode(e)), { state: "failed" });
    }

    switch (outcome.state) {
      case "signed": {
        const result = await handler(args, ctx, outcome.signature);
        return withSignatureMeta(result, {
          state: "signed",
          request_id: outcome.signature.requestId,
          signed_at: outcome.signature.signedAt,
        });
      }
      case "expired":
        return notRun(messages.expired(outcome.show, tool), { state: "expired" });
      case "awaiting":
        return awaitingAnswer(tool, ctx, outcome, continuing, round);
    }
  }

  function registerTool<OutputArgs extends StandardSchemaWithJSON, InputArgs extends StandardSchemaWithJSON | undefined = undefined>(
    name: string,
    config: SignedToolConfig<InputArgs, OutputArgs>,
    handler: SignedToolHandler<InputArgs>,
  ): RegisteredTool {
    const { show: _show, ...definition } = config;
    // Without an input schema the SDK passes only the context; such a call signs empty arguments
    const callback = (
      config.inputSchema !== undefined
        ? (args: ToolArgs<InputArgs>, ctx: ServerContext) => run(name, config, handler, args, ctx)
        : (ctx: ServerContext) => run(name, config, handler, {} as ToolArgs<InputArgs>, ctx)
    ) as ToolCallback<InputArgs>;
    return server.registerTool(
      name,
      { ...definition, _meta: { ...config._meta, [SIGNATURE_META_KEY]: { required: true } } },
      callback,
    );
  }

  return { registerTool };
}
