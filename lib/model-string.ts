import { attributeKey, mergedObject, unknownKeysMessage, type BootConfig } from "./config.ts";
import { errorMessage, isPlainObject } from "./util.ts";

/**
 * Model string parsing and resolution per specs/model-string.md (as revised:
 * one `:<thinking-level>` suffix, exact `provider/id` inventory
 * matching only, no literal or bare-id fallback, wrong strings error).
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelErrorCode =
  | "invalid-plan"
  | "ambiguous-model"
  | "missing-model"
  | "missing-model-class"
  | "unsupported-thinking";

export class ModelStringError extends Error {
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.name = "ModelStringError";
    this.code = code;
  }
}

export interface Descriptor {
  provider: string;
  id: string;
  thinking?: ThinkingLevel | undefined;
}

/** Inventory model shape (pi Model subset used for resolution). */
export interface InventoryModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}

type Parsed = { kind: "concrete"; provider: string; id: string } | { kind: "class"; name: string };

const INVALID = (message: string) => new ModelStringError("invalid-plan", message);

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

/** Final `:`-separated segment of a model id. */
function lastSegment(id: string): string {
  const index = id.lastIndexOf(":");
  return index === -1 ? id : id.slice(index + 1);
}

function validateProvider(provider: string): void {
  if (provider === "" || /\s/.test(provider) || provider.includes(":") || provider.includes("/")) {
    throw INVALID("empty provider, model, or thinking component");
  }
}

function validateModelId(id: string): void {
  if (
    id === "" ||
    /\s/.test(id) ||
    id.startsWith("/") ||
    id.endsWith("/") ||
    id.includes("//") ||
    id.endsWith(":")
  ) {
    throw INVALID("empty provider, model, or thinking component");
  }
  if (isThinkingLevel(lastSegment(id))) {
    throw INVALID("reserved thinking suffix");
  }
}

/** Parse the grammar of Section 1. Throws ModelStringError with code invalid-plan. */
export function parseModelString(raw: unknown): {
  selector: Parsed;
  thinking?: ThinkingLevel | undefined;
} {
  if (typeof raw !== "string") throw INVALID("model string must be a string");
  const trimmed = raw.trim();
  if (trimmed === "") throw INVALID("model string must be non-empty");
  if (/\s/.test(trimmed)) throw INVALID("model string must contain no internal whitespace");

  const firstSlash = trimmed.indexOf("/");
  const firstColon = trimmed.indexOf(":");
  if (firstSlash !== -1 && firstColon !== -1 && firstColon < firstSlash) {
    throw INVALID(`slash after the first colon: "${trimmed}"`);
  }

  let selectorText = trimmed;
  let thinking: ThinkingLevel | undefined;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = trimmed.slice(lastColon + 1);
    if (isThinkingLevel(tail)) {
      thinking = tail;
      selectorText = trimmed.slice(0, lastColon);
    }
  }

  let selector: Parsed;
  if (selectorText.includes("/")) {
    const slash = selectorText.indexOf("/");
    const provider = selectorText.slice(0, slash);
    const id = selectorText.slice(slash + 1);
    validateProvider(provider);
    validateModelId(id);
    selector = { kind: "concrete", provider, id };
  } else {
    if (selectorText === "" || /\s/.test(selectorText) || selectorText.includes(":")) {
      throw INVALID(`invalid class name "${selectorText}"`);
    }
    selector = { kind: "class", name: selectorText };
  }
  return { selector, thinking };
}

export interface ResolveContext<TModel extends InventoryModel = InventoryModel> {
  /** Active modelClasses mapping (raw merged config values). */
  classes: Record<string, unknown> | undefined;
  /** Host pi runtime's registered model list; always an array, possibly empty (model-string.md Section 4). */
  inventory: readonly TModel[];
  /** File path to attribute modelClasses diagnostics to. */
  attributeClassPath(name: string): string;
}

type NoMatch = { code: "missing-model" | "missing-model-class"; message: string };

function inventoryExactMatch<TModel extends InventoryModel>(
  inventory: readonly TModel[],
  descriptor: Descriptor,
): TModel | NoMatch {
  const matches = inventory.filter(
    (model) => model.provider === descriptor.provider && model.id === descriptor.id,
  );
  if (matches.length === 0) {
    return {
      code: "missing-model",
      message: `"${descriptor.provider}/${descriptor.id}" does not exactly match the available model inventory`,
    };
  }
  if (matches.length > 1) {
    const candidates = matches.map((model) => `${model.provider}/${model.id}`).join(", ");
    throw new ModelStringError(
      "ambiguous-model",
      `"${descriptor.provider}/${descriptor.id}" matches ${matches.length} inventory models: ${candidates}`,
    );
  }
  const match = matches[0];
  if (!match) throw new Error("inventory match disappeared");
  return match;
}

export function getSupportedThinkingLevels(model: InventoryModel): readonly ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function checkThinkingSupport(
  model: InventoryModel | undefined,
  level: ThinkingLevel | undefined,
): void {
  if (!model || level === undefined) return;
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(level)) {
    throw new ModelStringError(
      "unsupported-thinking",
      `model "${model.provider}/${model.id}" does not support thinking level "${level}"`,
    );
  }
}

function mappingToDescriptor(name: string, value: unknown): Descriptor {
  if (typeof value === "string") {
    const parsed = parseModelString(value);
    if (parsed.selector.kind !== "concrete") {
      throw INVALID(
        `modelClasses.${name}: class references must not appear as configuration values (no chaining)`,
      );
    }
    return {
      provider: parsed.selector.provider,
      id: parsed.selector.id,
      thinking: parsed.thinking,
    };
  }
  if (isPlainObject(value)) {
    const record = value;
    if (typeof record.provider !== "string" || typeof record.id !== "string") {
      throw INVALID(`modelClasses.${name}: descriptor requires string provider and id`);
    }
    validateProvider(record.provider);
    validateModelId(record.id);
    let thinking: ThinkingLevel | undefined;
    if (record.thinking !== undefined) {
      if (typeof record.thinking !== "string" || !isThinkingLevel(record.thinking)) {
        throw INVALID(`modelClasses.${name}: invalid thinking level`);
      }
      thinking = record.thinking;
    }
    return { provider: record.provider, id: record.id, thinking };
  }
  throw INVALID(
    `modelClasses.${name}: value must be a concrete model string or a { provider, id, thinking? } object`,
  );
}

/**
 * Boot-time validation of the `modelClasses` mapping (Section 3): keys must be
 * well-formed class names and values well-formed concrete mappings. Problems
 * are reported; entries are kept so reference-time resolution is unchanged.
 * Unknown descriptor fields are reported by `modelClassDiagnostics`, which can
 * attribute each field to its owning layer.
 */
export function validateModelClasses(classes: Record<string, unknown> | undefined): string[] {
  if (!classes) return [];
  const problems: string[] = [];
  for (const [name, value] of Object.entries(classes)) {
    if (name === "" || /\s/.test(name) || name.includes("/") || name.includes(":")) {
      problems.push(`modelClasses key "${name}" must be non-empty with no whitespace, "/", or ":"`);
      continue;
    }
    try {
      mappingToDescriptor(name, value);
    } catch (error) {
      problems.push(`modelClasses.${name}: ${errorMessage(error)}`);
    }
  }
  return problems;
}

/** Own keys of a model class descriptor outside the fields a class mapping defines. */
function unknownDescriptorFields(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).filter(
    (key) => key !== "provider" && key !== "id" && key !== "thinking",
  );
}

function resolveMapping<TModel extends InventoryModel>(
  name: string,
  value: unknown,
  ctx: ResolveContext<TModel>,
  explicitThinking: ThinkingLevel | undefined,
): { descriptor: Descriptor; model: TModel } | NoMatch {
  const base = mappingToDescriptor(name, value);
  const descriptor: Descriptor = { provider: base.provider, id: base.id };
  if (explicitThinking !== undefined) {
    descriptor.thinking = explicitThinking;
  } else if (base.thinking !== undefined) {
    descriptor.thinking = base.thinking;
  }
  const result = inventoryExactMatch(ctx.inventory, descriptor);
  if ("code" in result) {
    return {
      code: result.code,
      message: `${result.message} (modelClasses.${name}, ${ctx.attributeClassPath(name)})`,
    };
  }
  checkThinkingSupport(result, descriptor.thinking);
  return { descriptor, model: result };
}

function applyFallback<TModel extends InventoryModel>(
  noMatch: NoMatch,
  ctx: ResolveContext<TModel>,
  explicitThinking: ThinkingLevel | undefined,
): ResolvedModel<TModel> {
  const classes = ctx.classes;
  const fallbackValue =
    classes !== undefined && Object.hasOwn(classes, "fallback") ? classes.fallback : undefined;
  if (fallbackValue === undefined) {
    throw new ModelStringError(noMatch.code, noMatch.message);
  }
  // The fallback mapping resolves once as a concrete selector; its own
  // resolution never chains further.
  const resolved = resolveMapping("fallback", fallbackValue, ctx, explicitThinking);
  if ("code" in resolved) {
    throw new ModelStringError(resolved.code, resolved.message);
  }
  return resolved;
}

export interface ResolvedModel<TModel extends InventoryModel = InventoryModel> {
  descriptor: Descriptor;
  model: TModel;
}

/**
 * Resolve a model string per Section 4. Grammar and ambiguity violations fail
 * without fallback; no-match outcomes fall back through the `fallback` class
 * when it is defined.
 */
export function resolveModelString<TModel extends InventoryModel>(
  raw: unknown,
  ctx: ResolveContext<TModel>,
): ResolvedModel<TModel> {
  const parsed = parseModelString(raw);

  if (parsed.selector.kind === "concrete") {
    const descriptor: Descriptor = {
      provider: parsed.selector.provider,
      id: parsed.selector.id,
      thinking: parsed.thinking,
    };
    const result = inventoryExactMatch(ctx.inventory, descriptor);
    if ("code" in result) {
      return applyFallback(result, ctx, parsed.thinking);
    }
    checkThinkingSupport(result, descriptor.thinking);
    return { descriptor, model: result };
  }

  const name = parsed.selector.name;
  const classes = ctx.classes;
  const value = classes !== undefined && Object.hasOwn(classes, name) ? classes[name] : undefined;
  if (value === undefined) {
    return applyFallback(
      {
        code: "missing-model-class",
        message: `modelClasses.${name} is not configured (${ctx.attributeClassPath(name)})`,
      },
      ctx,
      parsed.thinking,
    );
  }
  const resolved = resolveMapping(name, value, ctx, parsed.thinking);
  if ("code" in resolved) {
    return applyFallback(resolved, ctx, parsed.thinking);
  }
  return resolved;
}

/** Canonical serialization per Section 5. */
export function serializeDescriptor(descriptor: Descriptor): string {
  const base = `${descriptor.provider}/${descriptor.id}`;
  return descriptor.thinking === undefined ? base : `${base}:${descriptor.thinking}`;
}

/**
 * The `modelClasses` mapping with each value in canonical serialization,
 * keyed in ascending ASCII order of class name. Invalid entries are skipped
 * (boot validation already reports them).
 */
export function serializeModelClasses(
  classes: Record<string, unknown> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!classes) return result;
  for (const name of Object.keys(classes).toSorted()) {
    try {
      result[name] = serializeDescriptor(mappingToDescriptor(name, classes[name]));
    } catch {
      // Skipped: reported at boot.
    }
  }
  return result;
}

/** Resolve context over the boot configuration's modelClasses mapping. */
export function resolveContextFromConfig<TModel extends InventoryModel>(
  config: BootConfig,
  inventory: readonly TModel[],
): ResolveContext<TModel> {
  return {
    get classes() {
      return mergedObject(config, "modelClasses");
    },
    inventory,
    attributeClassPath: (name: string) => attributeKey(config, ["modelClasses", name]),
  };
}

/** Boot validation of modelClasses (Section 3), each problem attributed to its owning layer. */
export function modelClassDiagnostics(config: BootConfig): string[] {
  const raw = config.merged.modelClasses;
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) {
    return [
      `config: modelClasses must be an object; ignored (${attributeKey(config, ["modelClasses"])})`,
    ];
  }
  const diagnostics: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    // Unknown descriptor fields are ignored and the class still resolves (config-file.md Section 2).
    const unknownFields = unknownDescriptorFields(value);
    if (unknownFields.length > 0) {
      diagnostics.push(
        `config: ${unknownKeysMessage(`modelClasses.${name}`, unknownFields, (field) => attributeKey(config, ["modelClasses", name, field]))}`,
      );
    }
    const problems = validateModelClasses({ [name]: value });
    for (const problem of problems) {
      const file = attributeKey(config, ["modelClasses", name]);
      diagnostics.push(`config: ${problem} (${file})`);
    }
  }
  return diagnostics;
}
