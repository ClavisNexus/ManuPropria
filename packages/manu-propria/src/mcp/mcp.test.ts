import { AppClientError } from "@clavis.nexus/app";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, createRequestStateCodec, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { gateWithRuntime, type SignedCall } from "../gate.js";
import { memoryStore } from "../store.js";
import { fakeClavis } from "../test-support/fake-clavis.js";
import { requireSignatures, SIGNATURE_META_KEY, type RequireSignaturesOptions } from "./index.js";

type UrlRequest = { message: string; url: string };
type Era = "modern" | "legacy";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

/** An MCP server with one signed tool, served in-process, and a gate whose waits take no real time. */
function harness(options: Partial<RequireSignaturesOptions> & { codec?: boolean } = {}) {
  const clavis = fakeClavis();
  let at = 1_791_747_000_000;
  const gate = gateWithRuntime(
    { app: clavis.app, store: memoryStore() },
    {
      now: () => at,
      sleep: async (ms) => {
        at += ms;
      },
    },
  );
  const codec = options.codec ? createRequestStateCodec({ key: crypto.getRandomValues(new Uint8Array(32)), ttlSeconds: 600 }) : undefined;
  const runs: Array<{ args: { orderId: string; amount: number }; signature: SignedCall }> = [];
  const errors: unknown[] = [];

  function buildServer(): McpServer {
    const server = new McpServer({ name: "northwind", version: "1.0.0" }, codec ? { requestState: { verify: codec.verify } } : undefined);
    const signed = requireSignatures(server, {
      gate,
      signer: () => "pw-alice",
      onError: (error) => errors.push(error),
      ...(codec ? { requestState: { mint: (payload) => codec.mint(payload as never) } } : {}),
      ...options,
    });
    signed.registerTool(
      "refund",
      {
        description: "Refund an order",
        inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
        show: ({ orderId, amount }) => `Refund $${amount.toFixed(2)} on order ${orderId}`,
      },
      async (args, _ctx, signature) => {
        runs.push({ args, signature });
        return { content: [{ type: "text", text: `Refunded order ${args.orderId}` }] };
      },
    );
    return server;
  }

  const handler = createMcpHandler(buildServer);
  closers.push(() => handler.close());

  /**
   * A 2026-07-28 client reaches the HTTP handler. A 2025-era client gets a connection with a session, as over
   * stdio, unless `stateless` asks for the HTTP handler's per-request legacy serving.
   */
  async function connect(
    era: Era,
    onUrl: (request: UrlRequest) => "accept" | "decline" | "cancel",
    options: { url?: boolean; stateless?: boolean } = {},
  ) {
    const client = new Client(
      { name: "test-host", version: "1.0.0" },
      {
        capabilities: { elicitation: options.url === false ? { form: {} } : { form: {}, url: {} } },
        ...(era === "modern" ? { versionNegotiation: { mode: "auto" as const } } : {}),
      },
    );
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as { mode?: string; message: string; url?: string };
      if (params.mode !== "url" || !params.url) return { action: "decline" };
      return { action: onUrl({ message: params.message, url: params.url }) };
    });
    if (era === "legacy" && !options.stateless) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = buildServer();
      await server.connect(serverTransport);
      closers.push(() => server.close());
      await client.connect(clientTransport);
    } else {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
          fetch: (input, init) => handler.fetch(new Request(input, init)),
        }),
      );
    }
    closers.push(() => client.close());
    expect(client.getProtocolEra()).toBe(era);
    return client;
  }

  const refund = { name: "refund", arguments: { orderId: "1042", amount: 120 } };
  return { clavis, runs, errors, connect, refund };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

function signatureMeta(result: unknown): Record<string, unknown> | undefined {
  return (result as { _meta?: Record<string, Record<string, unknown>> })._meta?.[SIGNATURE_META_KEY];
}

describe.each<Era>(["modern", "legacy"])("a signed tool over the %s protocol", (era) => {
  it("runs once the person signs on the page the client opens", async () => {
    const { clavis, runs, connect, refund } = harness();
    const prompts: UrlRequest[] = [];
    const client = await connect(era, (request) => {
      prompts.push(request);
      clavis.sign();
      return "accept";
    });
    const result = await client.callTool(refund);
    expect(textOf(result)).toBe("Refunded order 1042");
    expect(prompts).toEqual([
      { message: "Sign with your passkey to run this: Refund $120.00 on order 1042", url: expect.stringMatching(/^https:\/\/api\.clavis\.test\//) },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args).toEqual({ orderId: "1042", amount: 120 });
    expect(runs[0]?.signature.document).toMatchObject({
      name: "refund",
      arguments: { orderId: "1042", amount: 120 },
      show: "Refund $120.00 on order 1042",
      signer: "pw-alice",
    });
    expect(signatureMeta(result)).toEqual({ state: "signed", request_id: runs[0]?.signature.requestId, signed_at: expect.any(Number) });
  });

  it("does not run when the person declines, and asks afresh next time", async () => {
    const { clavis, runs, connect, refund } = harness();
    const client = await connect(era, () => "decline");
    const result = await client.callTool(refund);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Not signed: “Refund $120.00 on order 1042”. Nothing has run.");
    expect(signatureMeta(result)).toEqual({ state: "declined" });
    expect(runs).toHaveLength(0);
    await client.callTool(refund);
    expect(clavis.requests.size).toBe(2);
  });

  it("does not run without a person to sign", async () => {
    const { clavis, runs, connect, refund } = harness({ signer: () => undefined });
    const client = await connect(era, () => "accept");
    const result = await client.callTool(refund);
    expect(result.isError).toBe(true);
    expect(signatureMeta(result)).toEqual({ state: "no_signer" });
    expect(runs).toHaveLength(0);
    expect(clavis.requests.size).toBe(0);
  });

  it("does not run when the request lapses", async () => {
    const { clavis, runs, connect, refund } = harness();
    const client = await connect(era, () => {
      clavis.expire();
      return "accept";
    });
    const result = await client.callTool(refund);
    expect(textOf(result)).toBe(
      "The signature request for “Refund $120.00 on order 1042” lapsed before it was signed. Nothing has run. Calling refund again opens a new request.",
    );
    expect(runs).toHaveLength(0);
  });

  it("refuses a line that would read differently from what it contains", async () => {
    const { clavis, runs, errors, connect } = harness();
    const client = await connect(era, () => "accept");
    const result = await client.callTool({ name: "refund", arguments: { orderId: "\u202e2401", amount: 120 } });
    expect(textOf(result)).toBe("The signature could not be requested (invalid_call). Nothing has run.");
    expect(errors).toHaveLength(1);
    expect(runs).toHaveLength(0);
    expect(clavis.requests.size).toBe(0);
  });

  it("reports Clavis's refusal by its code and runs nothing", async () => {
    const { clavis, runs, errors, connect, refund } = harness();
    clavis.failRegistration(
      new AppClientError("register_failed", "register HTTP 402 SIGNATURE_CEILING", 402, { apiError: "SIGNATURE_CEILING" }),
    );
    const client = await connect(era, () => "accept");
    const result = await client.callTool(refund);
    expect(textOf(result)).toBe("The signature could not be requested (SIGNATURE_CEILING). Nothing has run.");
    expect(errors).toHaveLength(1);
    expect(runs).toHaveLength(0);
  });

  it("hands the address over when the client cannot open one, and runs when called again after the signature", async () => {
    const { clavis, runs, connect, refund } = harness();
    const client = await connect(era, () => "accept", { url: false });
    const first = await client.callTool(refund);
    expect(first.isError).toBe(true);
    const url = clavis.last().requestId;
    expect(textOf(first)).toContain(`Ask the person to open https://api.clavis.test/app/intent-requests/consume/${url}`);
    expect(signatureMeta(first)).toMatchObject({ state: "awaiting" });
    expect(runs).toHaveLength(0);
    clavis.sign();
    expect(textOf(await client.callTool(refund))).toBe("Refunded order 1042");
    expect(runs).toHaveLength(1);
  });

  it("refuses outright when told to and the client cannot open an address", async () => {
    const { runs, connect, refund } = harness({ withoutUrlElicitation: "refuse" });
    const client = await connect(era, () => "accept", { url: false });
    const result = await client.callTool(refund);
    expect(signatureMeta(result)).toEqual({ state: "unsupported" });
    expect(runs).toHaveLength(0);
  });

  it("marks the tool as needing a signature", async () => {
    const { connect } = harness();
    const client = await connect(era, () => "accept");
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "refund")?._meta?.[SIGNATURE_META_KEY]).toEqual({ required: true });
  });
});

describe("waiting longer than one round", () => {
  it("keeps a 2026-07-28 client retrying quietly until the signature lands", async () => {
    const { clavis, runs, connect, refund } = harness();
    const prompts: UrlRequest[] = [];
    // One round holds for 45 s at 2.5 s a read: 18 reads. Sign during the third round.
    clavis.whenStatusRead((request) => {
      if (request.statusReads === 40) clavis.sign(request);
    });
    const client = await connect("modern", (request) => {
      prompts.push(request);
      return "accept";
    });
    expect(textOf(await client.callTool(refund))).toBe("Refunded order 1042");
    expect(prompts).toHaveLength(1);
    expect(runs).toHaveLength(1);
  });

  it("works with a server that verifies requestState, given the same codec", async () => {
    const { clavis, runs, connect, refund } = harness({ codec: true });
    clavis.whenStatusRead((request) => {
      if (request.statusReads === 25) clavis.sign(request);
    });
    const client = await connect("modern", () => "accept");
    expect(textOf(await client.callTool(refund))).toBe("Refunded order 1042");
    expect(runs).toHaveLength(1);
  });

  it("ends a 2025-era call while still waiting, and runs on the next call once signed", async () => {
    const { clavis, runs, connect, refund } = harness();
    const client = await connect("legacy", () => "accept");
    const first = await client.callTool(refund);
    expect(textOf(first)).toBe(
      "Still waiting for the signature on “Refund $120.00 on order 1042”. Nothing has run. Once it is signed, call refund again with the same arguments.",
    );
    expect(runs).toHaveLength(0);
    clavis.sign();
    expect(textOf(await client.callTool(refund))).toBe("Refunded order 1042");
    expect(runs).toHaveLength(1);
    expect(clavis.requests.size).toBe(1);
  });
});

describe("2025-era clients of a stateless HTTP handler", () => {
  it("get the address to pass on, since no session carries their capabilities or the page request", async () => {
    const { clavis, runs, connect, refund } = harness();
    const prompts: UrlRequest[] = [];
    const client = await connect("legacy", (request) => {
      prompts.push(request);
      return "accept";
    }, { stateless: true });
    const first = await client.callTool(refund);
    expect(signatureMeta(first)).toMatchObject({ state: "awaiting" });
    expect(prompts).toHaveLength(0);
    clavis.sign();
    expect(textOf(await client.callTool(refund))).toBe("Refunded order 1042");
    expect(runs).toHaveLength(1);
  });
});

describe("one signature, one run", () => {
  it("asks again for the same call after it has run", async () => {
    const { clavis, runs, connect, refund } = harness();
    const client = await connect("modern", () => {
      clavis.sign();
      return "accept";
    });
    await client.callTool(refund);
    await client.callTool(refund);
    expect(runs).toHaveLength(2);
    expect(clavis.requests.size).toBe(2);
    expect(runs[0]?.signature.requestId).not.toBe(runs[1]?.signature.requestId);
  });
});
