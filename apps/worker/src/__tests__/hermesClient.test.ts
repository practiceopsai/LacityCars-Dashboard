import { afterEach, describe, expect, it, vi } from "vitest";
import type { HermesTriggerPayload } from "@lacity/shared";
import type { WorkerConfig } from "../config";
import { HermesTriggerError, triggerHermes } from "../hermesClient";

const config = {
  HERMES_ENDPOINT: "https://hermes.example.com/trigger",
  HERMES_API_TOKEN: "test-token-1234",
  HERMES_TIMEOUT_MS: 5000,
} as WorkerConfig;

const payload = {
  request_id: "veh-1:1",
  callback_url: "https://api.example.com/api/webhooks/hermes",
} as HermesTriggerPayload;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("triggerHermes", () => {
  it("POSTs the payload with bearer auth and resolves on 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerHermes(config, payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config.HERMES_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${config.HERMES_API_TOKEN}`,
    );
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("throws HermesTriggerError with status code on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 503 })),
    );

    const err = await triggerHermes(config, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HermesTriggerError);
    expect((err as HermesTriggerError).statusCode).toBe(503);
    expect((err as HermesTriggerError).message).toContain("503");
  });

  it("wraps network failures in HermesTriggerError without a status code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const err = await triggerHermes(config, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HermesTriggerError);
    expect((err as HermesTriggerError).statusCode).toBeUndefined();
    expect((err as HermesTriggerError).message).toContain("fetch failed");
  });
});
