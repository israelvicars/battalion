const SAFE_SLUG_BODY = "[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?";
export const SAFE_SLUG = new RegExp(`^${SAFE_SLUG_BODY}$`);

// Exactly `<agent>-task-<ms timestamp>-<8 hex>`, as built by the hub (see makeId in cli/main.ts).
const HUB_APPROVAL_ID = /^[a-z][a-z0-9-]{0,31}-task-\d{13}-[0-9a-f]{8}$/;

export function isHubGeneratedApprovalId(value: unknown): value is string {
  return typeof value === "string" && HUB_APPROVAL_ID.test(value);
}

export function isSafeSlug(value: unknown): value is string {
  return typeof value === "string" && SAFE_SLUG.test(value);
}

export function assertSafeSlug(value: unknown, name: string): asserts value is string {
  if (!isSafeSlug(value)) {
    throw new Error(`${name} must be a traversal-safe slug of at most 128 characters`);
  }
}
