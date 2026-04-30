export class GoogleAuthRequired extends Error {
  readonly code = "GOOGLE_AUTH_REQUIRED";
  constructor(public readonly scopes: string[]) {
    super("Google authorization required");
  }
}

export class RateLimited extends Error {
  readonly code = "RATE_LIMITED";
  constructor(public readonly retryAfterSec: number) {
    super(`Rate limited, retry in ${retryAfterSec}s`);
  }
}

export class NeedsConfirmation extends Error {
  readonly code = "NEEDS_CONFIRMATION";
  constructor(public readonly summary: string) {
    super(summary);
  }
}
