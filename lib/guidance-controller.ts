import { BillingService, type BillingBus, type Timers } from "./billing.ts";
import { readLocalZone } from "./billing-text.ts";
import { guidanceToInject } from "./guidance-inject.ts";
import {
  GUIDANCE_CUSTOM_TYPE,
  type ModelGuidance,
  guidanceBillingProviders,
} from "./model-guidance.ts";
import type { InventoryModel } from "./model-string.ts";
import { type Diagnostic, errorMessage } from "./util.ts";

/**
 * The guidance message injection triggers of one extension instance
 * (specs/model-guidance.md#guidance-message, specs/billing.md#queries): when to
 * inject, the cached query before computing, the deferred `session_start`
 * injection, and the instance's billing service.
 */

/** The part of the host extension context the controller reads. */
export interface GuidanceContext {
  model?: { provider: string; id: string } | undefined;
  sessionManager: {
    getBranch(): readonly { type: string; customType?: string; content?: unknown }[];
  };
  modelRegistry?: { getAvailable(): readonly InventoryModel[] } | undefined;
}

export interface GuidanceMessage {
  customType: string;
  content: string;
  display: true;
}

export interface GuidanceControllerDeps {
  guidance: ModelGuidance;
  /** `modelGuidance.billing`. */
  billingEnabled: boolean;
  bus: BillingBus;
  /** Inject through the host `sendMessage` API with no turn started. */
  send(message: GuidanceMessage): void;
  timeZone?: string;
  timers?: Timers;
  now?: () => number;
  /** Where a failure that is not a query outcome goes (specs/billing.md#diagnostics). */
  diagnostics?: (diagnostic: Diagnostic) => void;
}

export class GuidanceController {
  /** The instance's billing service; `undefined` while billing is disabled. */
  readonly billing: BillingService | undefined;
  private readonly guidance: ModelGuidance;
  private readonly send: (message: GuidanceMessage) => void;
  private readonly diagnostics: ((diagnostic: Diagnostic) => void) | undefined;
  private latest: GuidanceContext | undefined;
  private deferred: { ctx: GuidanceContext } | undefined;

  constructor(deps: GuidanceControllerDeps) {
    this.guidance = deps.guidance;
    this.send = deps.send;
    this.diagnostics = deps.diagnostics;
    this.billing = deps.billingEnabled
      ? new BillingService({
          bus: deps.bus,
          guidanceProviders: () => this.guidanceProviders(),
          timeZone: deps.timeZone ?? readLocalZone(),
          ...(deps.timers ? { timers: deps.timers } : {}),
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
        })
      : undefined;
  }

  /** Report a failure that is not a query outcome (specs/billing.md#diagnostics). */
  private reportFailure(message: string): void {
    this.diagnostics?.({ level: "warning", message });
  }

  private available(ctx: GuidanceContext | undefined): readonly InventoryModel[] {
    return ctx?.modelRegistry?.getAvailable() ?? [];
  }

  /** The guidance billing providers as of the latest context. */
  private guidanceProviders(): string[] {
    try {
      return guidanceBillingProviders(this.guidance, this.available(this.latest));
    } catch (error) {
      this.reportFailure(
        `billing: the guidance billing providers are unreadable: ${errorMessage(error)}`,
      );
      return [];
    }
  }

  private compute(
    ctx: GuidanceContext,
    modelOverride?: { provider: string; id: string } | null,
  ): string | undefined {
    const model = modelOverride === undefined ? ctx.model : modelOverride;
    return guidanceToInject(
      this.guidance,
      this.available(ctx),
      model ? `${model.provider}/${model.id}` : undefined,
      ctx.sessionManager.getBranch(),
      this.billing?.view(),
    );
  }

  private injectNow(ctx: GuidanceContext, modelOverride?: { provider: string; id: string } | null) {
    const content = this.compute(ctx, modelOverride);
    if (content !== undefined) {
      this.send({ customType: GUIDANCE_CUSTOM_TYPE, content, display: true });
    }
  }

  /**
   * `session_start`: poll, then inject now or, with a poll pending, once a poll
   * has an outcome other than `not-ready`. A `session_start` during the wait
   * makes no injection of its own.
   */
  sessionStart(ctx: GuidanceContext): void {
    this.latest = ctx;
    const billing = this.billing;
    // The context first: a poll with an immediate outcome releases the deferred
    // injection synchronously, and that injection computes with this context.
    const deferred = this.deferred;
    if (deferred) deferred.ctx = ctx;
    billing?.startPoll();
    if (deferred) return;
    if (!billing || !billing.pendingPoll()) {
      this.injectNow(ctx);
      return;
    }
    const registration = { ctx };
    this.deferred = registration;
    billing.onPollAnswer(() => {
      if (this.deferred !== registration || billing.closed) return;
      this.deferred = undefined;
      try {
        this.injectNow(registration.ctx);
      } catch (error) {
        this.reportFailure(
          `guidance: the deferred session_start injection failed: ${errorMessage(error)}`,
        );
      }
    });
  }

  /** `session_compact`. */
  async sessionCompact(ctx: GuidanceContext): Promise<void> {
    await this.cachedQueryThenInject(ctx);
  }

  /** `model_select`. */
  async modelSelect(ctx: GuidanceContext, model: { provider: string; id: string } | null) {
    await this.cachedQueryThenInject(ctx, model);
  }

  private async cachedQueryThenInject(
    ctx: GuidanceContext,
    modelOverride?: { provider: string; id: string } | null,
  ): Promise<void> {
    this.latest = ctx;
    if (this.billing) {
      await this.billing.cachedQueryWait(this.guidanceProviders());
      if (this.billing.closed) return;
    }
    this.injectNow(ctx, modelOverride);
  }

  /** `session_shutdown` of the extension instance. */
  shutdown(): void {
    this.deferred = undefined;
    this.billing?.close();
  }
}
