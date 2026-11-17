import { attributeKey, type BootConfig, unknownKeysMessage } from "./config.ts";
import {
  getSupportedThinkingLevels,
  parseModelString,
  serializeDescriptor,
  type InventoryModel,
  type ThinkingLevel,
} from "./model-string.ts";
import { errorMessage, isPlainObject } from "./util.ts";
import {
  type BillingView,
  billingAnnotation,
  billingNote,
  billingProviders,
} from "./billing-text.ts";

/**
 * Model guidance per specs/model-guidance.md: the `modelGuidance` configuration
 * key naming when to use which model, bounding dispatch to those models,
 * and guidance rules injected into every session whose model they match.
 */

export const GUIDANCE_CUSTOM_TYPE = "pi-dent-model-guidance";

export interface ModelEntry {
  key: string;
  provider: string;
  id: string;
  thinking?: ThinkingLevel;
  when: string;
}

export interface GuidanceRule {
  match: RegExp;
  rule: string;
}

export interface ModelGuidance {
  entries: ModelEntry[];
  rules: GuidanceRule[];
}

export interface GuidedModel {
  /** Canonical serialization of the key (model-string.md Section 5). */
  model: string;
  provider: string;
  id: string;
  thinking?: ThinkingLevel;
  when: string;
}

function parseModelKey(
  key: string,
): { provider: string; id: string; thinking?: ThinkingLevel } | string {
  let parsed: ReturnType<typeof parseModelString>;
  try {
    parsed = parseModelString(key);
  } catch (error) {
    return `invalid model selector: ${errorMessage(error)}`;
  }
  if (parsed.selector.kind !== "concrete") {
    return "key must be a concrete selector, not a class reference";
  }
  return {
    provider: parsed.selector.provider,
    id: parsed.selector.id,
    ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
  };
}

/** Own keys of an object value outside `known`; empty for non-objects. */
function unknownFieldsOf(value: unknown, known: readonly string[]): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).filter((key) => !known.includes(key));
}

/** One layer's own `modelGuidance.models` object, when that layer declares one. */
function layerModelsOf(
  values: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const guidance = values?.modelGuidance;
  if (!isPlainObject(guidance)) return undefined;
  const models = guidance.models;
  return isPlainObject(models) ? models : undefined;
}

function parseModelEntry(key: string, value: unknown): ModelEntry | string {
  const parsedKey = parseModelKey(key);
  if (typeof parsedKey === "string") return parsedKey;
  if (!isPlainObject(value)) return "entry must be an object";
  const rawWhen = value.when;
  if (typeof rawWhen !== "string" || rawWhen.trim() === "") {
    return '"when" must be a non-empty string';
  }
  return {
    key: serializeDescriptor({
      provider: parsedKey.provider,
      id: parsedKey.id,
      ...(parsedKey.thinking === undefined ? {} : { thinking: parsedKey.thinking }),
    }),
    provider: parsedKey.provider,
    id: parsedKey.id,
    ...(parsedKey.thinking === undefined ? {} : { thinking: parsedKey.thinking }),
    when: rawWhen.trim(),
  };
}

function parseGuidanceRule(value: unknown): GuidanceRule | string {
  if (!isPlainObject(value)) return "rule must be an object";
  if (typeof value.match !== "string") {
    return '"match" must be a string';
  }
  let regex: RegExp;
  try {
    regex = new RegExp(value.match, "u");
  } catch (error) {
    return `invalid "match" regular expression: ${errorMessage(error)}`;
  }
  const rawRule = value.rule;
  if (typeof rawRule !== "string" || rawRule.trim() === "") {
    return '"rule" must be a non-empty string';
  }
  return {
    match: regex,
    rule: rawRule.trim(),
  };
}

/**
 * One boot snapshot's parsed `modelGuidance`: the guidance, the `billing`
 * switch, and the diagnostics, all from one parse of the merged key.
 */
export interface ParsedModelGuidance {
  guidance: ModelGuidance;
  /** `modelGuidance.billing` (specs/billing.md Section 1): `true` unless it is the boolean `false`. */
  billing: boolean;
  diagnostics: string[];
}

/** The parsed configuration of each boot snapshot, by its configuration object. */
const parsedConfigs = new WeakMap<BootConfig, ParsedModelGuidance>();

/** Parse merged `modelGuidance` (config.merged.modelGuidance). */
export function parseModelGuidance(config: BootConfig): ParsedModelGuidance {
  const raw = config.merged.modelGuidance;
  if (raw === undefined) {
    return { guidance: { entries: [], rules: [] }, billing: true, diagnostics: [] };
  }
  if (!isPlainObject(raw)) {
    return {
      guidance: { entries: [], rules: [] },
      billing: true,
      diagnostics: [
        `config: modelGuidance must be an object; ignored (${attributeKey(config, ["modelGuidance"])})`,
      ],
    };
  }

  const diagnostics: string[] = [];
  const entries: ModelEntry[] = [];
  const rules: GuidanceRule[] = [];
  // Exactly one diagnostic per object, naming every unknown key (config-file.md Section 2).
  const unknownKeys = Object.keys(raw).filter(
    (key) => key !== "billing" && key !== "models" && key !== "rules",
  );
  if (unknownKeys.length > 0) {
    // Exactly one diagnostic per object, each key attributed to its own layer (config-file.md
    // Section 2); model entries and rules follow the same rule (model-guidance.md Section 1).
    diagnostics.push(
      `config: ${unknownKeysMessage("modelGuidance", unknownKeys, (key) => attributeKey(config, ["modelGuidance", key]))}`,
    );
  }
  if (raw.billing !== undefined) {
    if (typeof raw.billing !== "boolean") {
      diagnostics.push(
        `config: modelGuidance.billing must be a boolean; ignored (${attributeKey(config, ["modelGuidance", "billing"])})`,
      );
    }
  }

  if (raw.models !== undefined) {
    if (isPlainObject(raw.models)) {
      // The winner of a duplicate is decided per layer in that layer's own key order
      // (model-guidance.md Section 1): the project layer first, then the global layer, each
      // using the merged value the boot snapshot holds for that key. The merged object's key
      // order is not a layer's order: a key both layers declare sits at the global position.
      const order: Array<{ key: string; value: unknown }> = [];
      const visited = new Set<string>();
      for (const layer of [config.layers.project, config.layers.global]) {
        for (const key of Object.keys(layerModelsOf(layer?.values) ?? {})) {
          if (visited.has(key)) continue;
          visited.add(key);
          order.push({ key, value: raw.models[key] });
        }
      }
      // Keys no layer declares (a snapshot merged without layer values) keep the merged order.
      for (const [key, value] of Object.entries(raw.models)) {
        if (visited.has(key)) continue;
        visited.add(key);
        order.push({ key, value });
      }
      // Canonical key -> the raw key that loaded it.
      const loaded = new Map<string, string>();
      for (const { key, value } of order) {
        const parsed = parseModelEntry(key, value);
        if (typeof parsed === "string") {
          diagnostics.push(
            `config: modelGuidance.models.${key}: ${parsed}; skipped (${attributeKey(config, ["modelGuidance", "models", key])})`,
          );
          continue;
        }
        const winner = loaded.get(parsed.key);
        if (winner !== undefined) {
          diagnostics.push(
            `config: modelGuidance.models.${key}: duplicate of ${JSON.stringify(winner)} after trimming; skipped (${attributeKey(config, ["modelGuidance", "models", key])})`,
          );
          continue;
        }
        loaded.set(parsed.key, key);
        entries.push(parsed);
        const unknownFields = unknownFieldsOf(value, ["when"]);
        if (unknownFields.length > 0) {
          diagnostics.push(
            `config: ${unknownKeysMessage(`modelGuidance.models.${key}`, unknownFields, (field) => attributeKey(config, ["modelGuidance", "models", key, field]))}`,
          );
        }
      }
    } else {
      diagnostics.push(
        `config: modelGuidance.models must be an object; ignored (${attributeKey(config, ["modelGuidance", "models"])})`,
      );
    }
  }

  if (raw.rules !== undefined) {
    if (Array.isArray(raw.rules)) {
      for (let i = 0; i < raw.rules.length; i++) {
        const parsed = parseGuidanceRule(raw.rules[i]);
        if (typeof parsed === "string") {
          diagnostics.push(
            `config: modelGuidance.rules[${i}]: ${parsed}; skipped (${attributeKey(config, ["modelGuidance", "rules"])})`,
          );
        } else {
          rules.push(parsed);
          const unknownFields = unknownFieldsOf(raw.rules[i], ["match", "rule"]);
          if (unknownFields.length > 0) {
            // A rule array belongs to the layer that declares `rules` (Section 4).
            diagnostics.push(
              `config: ${unknownKeysMessage(`modelGuidance.rules[${i}]`, unknownFields, () => attributeKey(config, ["modelGuidance", "rules"]))}`,
            );
          }
        }
      }
    } else {
      diagnostics.push(
        `config: modelGuidance.rules must be an array; ignored (${attributeKey(config, ["modelGuidance", "rules"])})`,
      );
    }
  }

  return { guidance: { entries, rules }, billing: raw.billing !== false, diagnostics };
}

/**
 * The parsed `modelGuidance` of one configuration object, parsed once: every
 * consumer of a boot snapshot reads it from here, never from the raw key.
 */
export function parsedModelGuidance(config: BootConfig): ParsedModelGuidance {
  const cached = parsedConfigs.get(config);
  if (cached !== undefined) return cached;
  const result = parseModelGuidance(config);
  parsedConfigs.set(config, result);
  return result;
}

/** `modelGuidance.billing` (specs/billing.md Section 1): `true` unless it is the boolean `false`. */
export function billingEnabled(config: BootConfig): boolean {
  return parsedModelGuidance(config).billing;
}

/** Active iff the guided-model set is non-empty (specs/model-guidance.md Section 1). */
export function guidanceActive(g: ModelGuidance, available: readonly InventoryModel[]): boolean {
  return guidedModels(g, available).length > 0;
}

/** Guided models against the inventory; an empty inventory guides nothing (specs/model-guidance.md Section 2). */
export function guidedModels(
  g: ModelGuidance,
  available: readonly InventoryModel[],
): GuidedModel[] {
  const result: GuidedModel[] = [];
  const seenKeys = new Set<string>();

  for (const entry of g.entries) {
    if (seenKeys.has(entry.key)) {
      continue;
    }

    const matching = available.filter((m) => m.provider === entry.provider && m.id === entry.id);
    if (matching.length === 0) {
      continue;
    }

    const thinking = entry.thinking;
    if (thinking !== undefined) {
      const supports = matching.some((m) => getSupportedThinkingLevels(m).includes(thinking));
      if (!supports) {
        continue;
      }
    }

    seenKeys.add(entry.key);
    result.push({
      model: entry.key,
      provider: entry.provider,
      id: entry.id,
      ...(thinking === undefined ? {} : { thinking }),
      when: entry.when,
    });
  }

  result.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return result;
}

/** Guidance billing providers: the billing providers of the guided models (billing.md Section 3). */
export function guidanceBillingProviders(
  g: ModelGuidance,
  available: readonly InventoryModel[],
): string[] {
  return billingProviders(guidedModels(g, available).map((item) => item.provider));
}

/** Model catalog of a model list (specs/model-guidance.md Section 6); empty when guidance is inactive. */
export function modelCatalog(g: ModelGuidance, available: readonly InventoryModel[]): string {
  return guidedModels(g, available)
    .map((item) => `- ${item.model}: ${item.when}`)
    .join("\n");
}

/** Rule texts matching a session model given as canonical `provider/id` (specs/model-guidance.md Section 4). */
export function sessionRules(g: ModelGuidance, model: string | undefined): string[] {
  if (!model) return [];
  return g.rules.filter((r) => r.match.test(model)).map((r) => r.rule);
}

/**
 * Sections 1 and 2 of the guidance message content (specs/model-guidance.md
 * Section 5): the `Model billing:` lines of the guided models with a billing
 * annotation, and the billing note, both only while guidance billing text is
 * present (specs/billing.md Section 6.1).
 */
function guidanceSections(
  g: ModelGuidance,
  available: readonly InventoryModel[],
  billing: BillingView | undefined,
): string[] {
  const guided = guidedModels(g, available);
  if (guided.length === 0) return [];
  const providers = guidanceBillingProviders(g, available);
  if (!billing || !providers.some((p) => billing.entries.has(p))) return [];
  const lines = guided.flatMap((item) => {
    const annotation = billingAnnotation(billing.entries.get(item.provider), item.id, billing.zone);
    return annotation === "" ? [] : [`- ${item.model}:${annotation}`];
  });
  const billingLines = lines.length > 0 ? [["Model billing:", ...lines].join("\n")] : [];
  return [...billingLines, billingNote(billing)];
}

/** Complete guidance message content (specs/model-guidance.md Section 5). */
export function guidanceContent(
  g: ModelGuidance,
  available: readonly InventoryModel[],
  model: string | undefined,
  billing?: BillingView,
): string {
  const sections = guidanceSections(g, available, billing);
  const rules = sessionRules(g, model);
  if (rules.length > 0) {
    sections.push(rules.join("\n\n"));
  }
  return sections.join("\n\n");
}

/** Child guidance (specs/model-guidance.md Section 4): sections 1 and 2; empty without guided models. */
export function childGuidance(
  g: ModelGuidance,
  available: readonly InventoryModel[],
  billing: BillingView | undefined,
): string {
  return guidanceSections(g, available, billing).join("\n\n");
}

/** Match dispatch model and thinking against guided models (specs/model-guidance.md Section 3). */
export function isGuidedDispatch(
  guided: GuidedModel[],
  provider: string,
  id: string,
  thinking: ThinkingLevel | undefined,
): boolean {
  for (const g of guided) {
    if (g.provider === provider && g.id === id) {
      if (g.thinking === undefined || g.thinking === thinking) {
        return true;
      }
    }
  }
  return false;
}
