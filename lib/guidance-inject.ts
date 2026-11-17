import { GUIDANCE_CUSTOM_TYPE, guidanceContent, type ModelGuidance } from "./model-guidance.ts";
import type { InventoryModel } from "./model-string.ts";
import type { BillingView } from "./billing-text.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function extractEntryText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (isTextContent(part)) {
        texts.push(part.text);
      }
    }
    return texts.join("");
  }
  return undefined;
}

/**
 * Determine the guidance message content to inject into the main session, or
 * undefined if no content is produced (guidanceContent is empty) or the latest
 * guidance message after the latest compaction entry (the whole branch without
 * one) already has that text (specs/model-guidance.md Section 5).
 */
export function guidanceToInject(
  guidance: ModelGuidance,
  available: readonly InventoryModel[],
  model: string | undefined,
  branch: readonly { type: string; customType?: string; content?: unknown }[],
  billing?: BillingView,
): string | undefined {
  const content = guidanceContent(guidance, available, model, billing);
  if (content === "") {
    return undefined;
  }

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type === "compaction") break;
    if (entry.type === "custom_message" && entry.customType === GUIDANCE_CUSTOM_TYPE) {
      return extractEntryText(entry.content) === content ? undefined : content;
    }
  }

  return content;
}
