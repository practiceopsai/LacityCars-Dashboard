export interface StoreDto {
  id: string;
  code: string;
  name: string;
  aliases: string[];
  stockPrefix: string;
  autosoftInstance: string;
  internalCharges: { label: string; amount: number }[];
  chargesTotal: number;
  active: boolean;
  updatedAt: string;
}

export interface VehicleDto {
  id: string;
  vin: string;
  vinMasked: string;
  model: string;
  status:
    | "PENDING"
    | "AWAITING_FREIGHT"
    | "READY"
    | "PROCESSING"
    | "ACTION_REQUIRED"
    | "COMPLETED"
    | "FAILED";
  stockNumber: string | null;
  store: { code: string; name: string; stockPrefix: string };
  freightAmount: number | null;
  freightEvidence: Record<string, unknown> | null;
  freightAttempts: number;
  nextFreightCheckAt: string | null;
  acv: number | null;
  finalTotal: number | null;
  ragCommitId: string | null;
  failureReason: string | null;
  runSummary: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEventDto {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  message: string | null;
  payload: unknown;
  createdAt: string;
}

export interface CorrectionDto {
  id: string;
  note: string;
  fields: Record<string, string> | null;
  createdBy?: string;
  createdAt: string;
}

export interface VehicleDetailDto extends VehicleDto {
  timeline: TimelineEventDto[];
  corrections: CorrectionDto[];
}

export interface VehicleListDto {
  items: VehicleDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface IntakeResultDto {
  results: {
    vin: string;
    ok: boolean;
    vehicleId?: string;
    duplicate?: boolean;
    status?: string;
    errors?: string[];
  }[];
  summary: { created: number; duplicates: number; rejected: number };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

/**
 * Same-origin fetch wrapper. The X-Requested-With header is required by the
 * API on every mutation (CSRF defense-in-depth on top of SameSite cookies).
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      "X-Requested-With": "fetch",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (response.status === 401 && !path.startsWith("/api/auth")) {
    window.location.href = "/login";
    throw new ApiError(401, "UNAUTHENTICATED", "Session expired");
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiError(
      response.status,
      err?.code ?? "REQUEST_FAILED",
      err?.message ?? `Request failed (${response.status})`,
      err?.details,
    );
  }
  return payload as T;
}
