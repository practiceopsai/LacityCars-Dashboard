import { describe, expect, it, vi } from "vitest";
import type { IntakeVehicle } from "@lacity/shared";
import { loadConfig, resetConfigCache } from "../config";
import { IntakeClient } from "../intakeClient";

const BASE_ENV = {
  REDIS_URL: "redis://localhost:6379",
  AGENTMAIL_API_KEY: "am_test_key",
  AGENTMAIL_INBOX_ID: "stocking@test.agentmail.to",
  AGENTMAIL_WEBHOOK_SECRET: "whsec_dGVzdA==",
  STAFF_ALLOWLIST: "wendi@example.com, fvarenns@gmail.com",
  ALERT_EMAIL: "fvarenns@gmail.com",
  API_BASE_URL: "https://api.example.test",
  OPERATOR_PASSWORD: "operator-password",
  EXTRACTION_CALLBACK_SECRET: "0123456789abcdef0123456789abcdef",
  PUBLIC_BASE_URL: "https://mail.example.test",
  HERMES_ENDPOINT: "https://orgo.example.test/bash",
  HERMES_EXTRACTION_SECRET: "fedcba9876543210fedcba9876543210",
} as NodeJS.ProcessEnv;

function testConfig() {
  resetConfigCache();
  const config = loadConfig(BASE_ENV);
  resetConfigCache();
  return config;
}

const vehicle = (vin: string): IntakeVehicle => ({
  store: "LA_CITY",
  vin,
  model: "2022 Honda Civic Sport",
  scheduledAt: "2099-01-01T00:00:00.000Z",
});

const loginResponse = () =>
  new Response('{"authenticated":true}', {
    status: 200,
    headers: { "set-cookie": "lacity_session=tok123; Path=/; HttpOnly" },
  });

const intakeResponse = (vins: string[]) =>
  new Response(
    JSON.stringify({
      results: vins.map((vin) => ({ vin, ok: true, duplicate: false, status: "PENDING" })),
      summary: { created: vins.length, duplicates: 0, rejected: 0 },
    }),
    { status: 200 },
  );

describe("IntakeClient", () => {
  it("logs in once, sends the CSRF header and session cookie, and merges chunks", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const vins = Array.from({ length: 60 }, (_, i) => `VIN${String(i).padStart(3, "0")}`);
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/api/auth/login")) return loginResponse();
      const body = JSON.parse(String(init?.body)) as IntakeVehicle[];
      return intakeResponse(body.map((v) => v.vin));
    });

    const client = new IntakeClient(testConfig(), fetchMock as unknown as typeof fetch);
    const merged = await client.intake(vins.map(vehicle));

    expect(merged.summary.created).toBe(60);
    expect(merged.results).toHaveLength(60);
    const intakeCalls = calls.filter((c) => c.url.endsWith("/api/vehicles/intake"));
    expect(intakeCalls).toHaveLength(2); // 50 + 10
    const headers = intakeCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Requested-With"]).toBe("fetch");
    expect(headers.Cookie).toContain("lacity_session=tok123");
    expect(calls.filter((c) => c.url.endsWith("/api/auth/login"))).toHaveLength(1);
  });

  it("re-logs-in once when the session expires mid-run", async () => {
    let intakeAttempts = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/api/auth/login")) return loginResponse();
      intakeAttempts += 1;
      if (intakeAttempts === 1) return new Response("{}", { status: 401 });
      return intakeResponse(["2HGFE2F59NH503265"]);
    });

    const client = new IntakeClient(testConfig(), fetchMock as unknown as typeof fetch);
    const merged = await client.intake([vehicle("2HGFE2F59NH503265")]);
    expect(merged.summary.created).toBe(1);
    expect(intakeAttempts).toBe(2);
  });

  it("surfaces a 429 as a retryable error", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/api/auth/login")) return loginResponse();
      return new Response("{}", { status: 429 });
    });
    const client = new IntakeClient(testConfig(), fetchMock as unknown as typeof fetch);
    await expect(client.intake([vehicle("2HGFE2F59NH503265")])).rejects.toThrow("rate limit");
  });
});
