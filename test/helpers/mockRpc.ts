/**
 * A fake `fetch` that speaks just enough JSON-RPC to stand in for a Soroban
 * RPC node in tests. `handler` receives the method name and params and
 * returns the JSON-RPC `result`; throwing inside it produces a JSON-RPC
 * error response instead of an HTTP failure.
 */
export type RpcHandler = (method: string, params: any) => unknown | Promise<unknown>;

export interface MockRpcError extends Error {
  code?: number;
}

export function createMockFetch(handler: RpcHandler): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    try {
      const result = await handler(body.method, body.params);
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result });
    } catch (err) {
      const e = err as MockRpcError;
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: e.code ?? -32000, message: e.message },
      });
    }
  }) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  } as unknown as Response;
}

/** A fetch stand-in that always fails at the network layer (connection refused, DNS, etc). */
export function createFailingFetch(message = "connect ECONNREFUSED"): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}
