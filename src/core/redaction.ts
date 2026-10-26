import { createHash } from "node:crypto";

export type RedactionResult = {
  text: string;
  hits: number;
  kinds: Record<string, number>;
};

type Pattern = { kind: string; expression: RegExp };

const TOKEN_PATTERNS: Pattern[] = [
  {
    kind: "private-key",
    expression: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  { kind: "anthropic-key", expression: /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g },
  { kind: "openai-key", expression: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { kind: "github-token", expression: /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{8,}\b/g },
  { kind: "aws-access-key", expression: /\bAKIA[A-Z0-9]{16}\b/g },
  { kind: "slack-token", expression: /\bxox[abpr]-[A-Za-z0-9-]{8,}\b/g },
  { kind: "google-api-key", expression: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  {
    kind: "jwt",
    expression: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
];

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function looksHighEntropy(value: string): boolean {
  // Absolute and multi-segment filesystem paths often have enough character
  // variety to resemble tokens. They are scope metadata, not credentials.
  if (value.split("/").length > 3) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[-_+/=]/]
    .filter((expression) => expression.test(value)).length;
  return value.length >= 32 && classes >= 3 && entropy(value) >= 3.5;
}

function literalExpression(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

export class Redactor {
  private envPatterns: Pattern[];

  constructor(parentEnv: NodeJS.ProcessEnv = process.env) {
    this.envPatterns = Object.entries(parentEnv)
      .filter(([name, value]) =>
        /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(name) && typeof value === "string" && value.length >= 8)
      .map(([name, value]) => ({
        kind: `env-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        expression: literalExpression(value as string),
      }))
      .sort((left, right) => right.expression.source.length - left.expression.source.length);
  }

  redact(input: string): RedactionResult {
    let text = input;
    let hits = 0;
    const kinds: Record<string, number> = {};

    const apply = (pattern: Pattern): void => {
      pattern.expression.lastIndex = 0;
      text = text.replace(pattern.expression, () => {
        hits += 1;
        kinds[pattern.kind] = (kinds[pattern.kind] ?? 0) + 1;
        return `[REDACTED:${pattern.kind}]`;
      });
    };

    for (const pattern of this.envPatterns) apply(pattern);
    for (const pattern of TOKEN_PATTERNS) apply(pattern);

    text = text.replace(/[A-Za-z0-9+/_=-]{32,}/g, (candidate) => {
      if (!looksHighEntropy(candidate)) return candidate;
      hits += 1;
      kinds["high-entropy"] = (kinds["high-entropy"] ?? 0) + 1;
      return "[REDACTED:high-entropy]";
    });

    return { text, hits, kinds };
  }

  redactValue<T>(input: T): { value: T; hits: number } {
    let hits = 0;
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") {
        const redacted = this.redact(value);
        hits += redacted.hits;
        return redacted.text;
      }
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
      }
      return value;
    };
    return { value: walk(input) as T, hits };
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
