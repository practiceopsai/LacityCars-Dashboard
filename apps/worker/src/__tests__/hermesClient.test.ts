import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HermesTriggerPayload } from "@lacity/shared";
import type { WorkerConfig } from "../config";
import { HermesTriggerError, triggerHermes } from "../hermesClient";

const config = {
  HERMES_ENDPOINT: "https://hermes.example.com/trigger",
  HERMES_TRIGGER_SECRET: "test-trigger-secret-at-least-32-characters",
  HERMES_PROXY_TOKEN: "test-orgo-proxy-token",
  HERMES_TIMEOUT_MS: 180000,
} as WorkerConfig;

const payload = {
  request_id: "veh-1:1",
  callback_url: "https://api.example.com/api/webhooks/hermes",
} as HermesTriggerPayload;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("triggerHermes", () => {
  it("POSTs a Hermes-native HMAC-v2 event and resolves on 2xx", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_787_173_900_000);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerHermes(config, payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config.HERMES_ENDPOINT);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(headers.Authorization).toBe(`Bearer ${config.HERMES_PROXY_TOKEN}`);
    expect(headers["X-Webhook-Timestamp"]).toBe("1787173900");
    expect(headers["X-Request-ID"]).toBe(payload.request_id);
    expect(headers["X-Webhook-Signature-V2"]).toBe(
      createHmac("sha256", config.HERMES_TRIGGER_SECRET)
        .update(`1787173900.${body}`)
        .digest("hex"),
    );
    expect(JSON.parse(body)).toEqual({ event_type: "vehicle.ready", ...payload });
  });

  it("omits transport authorization when no proxy token is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerHermes({ ...config, HERMES_PROXY_TOKEN: "" }, payload);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("uses the authenticated Orgo command bridge for a local-only webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ exit_code: 0, stdout: '{"status":"accepted"}' }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await triggerHermes(
      { ...config, HERMES_LOCAL_WEBHOOK_URL: "http://127.0.0.1:8644/webhooks/vehicle-stocking" },
      payload,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const outerBody = JSON.parse(init.body as string) as { command: string };
    expect(headers.Authorization).toBe(`Bearer ${config.HERMES_PROXY_TOKEN}`);
    expect(headers["X-Webhook-Signature-V2"]).toBeUndefined();
    expect(outerBody.command).toContain("Start-Process");
    expect(outerBody.command).toContain("-WindowStyle','Hidden");
    expect(outerBody.command).toContain("-EncodedCommand");
    expect(outerBody.command).not.toContain("Invoke-RestMethod");
    expect(outerBody.command).not.toContain(payload.request_id);
    expect(outerBody.command).not.toContain(payload.callback_url);
    const encoded = /-EncodedCommand','([^']+)'/.exec(outerBody.command)?.[1];
    expect(encoded).toBeTruthy();
    const deliveryScript = Buffer.from(encoded!, "base64").toString("utf16le");
    expect(deliveryScript).toContain("FromBase64String");
    expect(deliveryScript).toContain("Invoke-RestMethod");
    expect(deliveryScript).toContain("-TimeoutSec 21600");
  });

  it("rejects an Orgo bridge command failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ exit_code: 1, stderr: "local webhook rejected" }), {
          status: 200,
        }),
      ),
    );

    await expect(
      triggerHermes(
        { ...config, HERMES_LOCAL_WEBHOOK_URL: "http://127.0.0.1:8644/webhooks/vehicle-stocking" },
        payload,
      ),
    ).rejects.toThrow("local webhook rejected");
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
