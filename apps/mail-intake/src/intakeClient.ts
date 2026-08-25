import { CSRF_HEADER_VALUE, SESSION_COOKIE, type IntakeVehicle } from "@lacity/shared";
import type { MailIntakeConfig } from "./config";

/**
 * Dashboard API client: operator-password session + CSRF header, chunked
 * array intake, one re-login retry on 401. Mirrors the browser contract.
 */

export interface IntakeItemResultDto {
  vin: string;
  ok: boolean;
  vehicleId?: string;
  duplicate?: boolean;
  status?: string;
  errors?: string[];
}

export interface IntakeResponseDto {
  results: IntakeItemResultDto[];
  summary: { created: number; duplicates: number; rejected: number };
}

const CHUNK_SIZE = 50;

export class IntakeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IntakeApiError";
  }
}

export class IntakeClient {
  private cookie: string | null = null;

  constructor(
    private readonly config: MailIntakeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async login(): Promise<void> {
    const response = await this.fetchImpl(`${this.config.API_BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.config.OPERATOR_PASSWORD }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new IntakeApiError(`Dashboard login failed: ${response.status}`, response.status);
    }
    const setCookie = response.headers.get("set-cookie");
    const match = setCookie?.match(new RegExp(`${SESSION_COOKIE}=[^;]+`));
    if (!match) {
      throw new IntakeApiError("Dashboard login returned no session cookie");
    }
    this.cookie = match[0];
  }

  private async post(vehicles: IntakeVehicle[], retried = false): Promise<IntakeResponseDto> {
    if (!this.cookie) await this.login();
    const response = await this.fetchImpl(`${this.config.API_BASE_URL}/api/vehicles/intake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": CSRF_HEADER_VALUE,
        Cookie: this.cookie!,
      },
      body: JSON.stringify(vehicles),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401 && !retried) {
      this.cookie = null;
      return this.post(vehicles, true);
    }
    if (response.status === 429) {
      throw new IntakeApiError("Dashboard rate limit hit — job will retry", 429);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new IntakeApiError(
        `Intake failed: ${response.status} ${body.slice(0, 300)}`,
        response.status,
      );
    }
    return (await response.json()) as IntakeResponseDto;
  }

  /** Submit vehicles in chunks; merges per-chunk results into one response. */
  async intake(vehicles: IntakeVehicle[]): Promise<IntakeResponseDto> {
    const merged: IntakeResponseDto = {
      results: [],
      summary: { created: 0, duplicates: 0, rejected: 0 },
    };
    for (let i = 0; i < vehicles.length; i += CHUNK_SIZE) {
      const chunk = vehicles.slice(i, i + CHUNK_SIZE);
      const response = await this.post(chunk);
      merged.results.push(...response.results);
      merged.summary.created += response.summary.created;
      merged.summary.duplicates += response.summary.duplicates;
      merged.summary.rejected += response.summary.rejected;
    }
    return merged;
  }
}
