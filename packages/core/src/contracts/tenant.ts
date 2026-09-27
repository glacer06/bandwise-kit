// TenantContext and PublishCtx.
// Both are in-process contracts, so their schemas are strict: unknown keys fail.

import { z } from "zod";

import {
  AgentClient,
  AppId,
  Client,
  KeyId,
  OrgId,
  PlanId,
  PlatformRole,
  PointerChannel,
  Role,
  RolloutStage,
  Scope,
  SetId,
  TokenId,
  UserId,
} from "./common.js";
import { SetInterface } from "./spec.js";
import { ModelRoute } from "./models.js";
import { SystemOneProvider } from "./system-one.js";

// ---------------------------------------------------------------------------
// Actors

/** A person in a console session. */
export const UserActor = z.strictObject({
  type: z.literal("user"),
  userId: UserId,
  role: Role,
  /** users.platform_role. */
  platformRole: PlatformRole.nullable(),
  /** Set during platform impersonation. */
  impersonatorId: UserId.nullable(),
});
export type UserActor = z.infer<typeof UserActor>;

/** sk_, pk_ or a browser JWT. */
export const AppTokenKind = z.enum(["secret", "publishable", "browser"]);
export type AppTokenKind = z.infer<typeof AppTokenKind>;

/** app_tokens.prefix. sk_ tokens are secret, pk_live_ is publishable. */
export const AppTokenPrefix = z.enum(["sk_live_", "sk_test_", "pk_live_"]);
export type AppTokenPrefix = z.infer<typeof AppTokenPrefix>;

/** slug@draft needs test mode (sk_test_). */
export const AppTokenMode = z.enum(["live", "test"]);
export type AppTokenMode = z.infer<typeof AppTokenMode>;

/**
 * A host-app token. A browser JWT carries the keyId, mode and channel of the sk_ token that
 * minted it, and is run-only.
 */
export const ApiKeyActor = z.strictObject({
  type: z.literal("apiKey"),
  keyId: KeyId,
  appId: AppId,
  tokenKind: AppTokenKind,
  mode: AppTokenMode,
  /** The token's bound channel. */
  channel: PointerChannel,
  scopes: z.array(Scope),
  /** Null means every set. */
  setIds: z.array(SetId).nullable(),
  /** The checked Origin; pk_ and browser tokens only. */
  origin: z.string().nullable(),
});
export type ApiKeyActor = z.infer<typeof ApiKeyActor>;

/** An sa_live_ agent token. role = min(role_ceiling, current membership role), per request. */
export const AgentActor = z.strictObject({
  type: z.literal("agent"),
  tokenId: TokenId,
  userId: UserId,
  role: Role,
  scopes: z.array(Scope),
  /** Null means every set. */
  setIds: z.array(SetId).nullable(),
  client: AgentClient,
});
export type AgentActor = z.infer<typeof AgentActor>;

/** Jobs and auto-demote. */
export const SystemActor = z.strictObject({ type: z.literal("system") });
export type SystemActor = z.infer<typeof SystemActor>;

export const Actor = z.discriminatedUnion("type", [UserActor, ApiKeyActor, AgentActor, SystemActor]);
export type Actor = z.infer<typeof Actor>;

export type ActorKind = Actor["type"];

// ---------------------------------------------------------------------------
// TenantContext

export const TenantContext = z.strictObject({
  orgId: OrgId,
  actor: Actor,
  /**
   * The surface of this request: "console" for Server Actions, "api" for app tokens and cookie
   * calls to /api/v1, the token's client for agent tokens, "job" for system.
   */
  client: Client,
  plan: PlanId,
  requestId: z.string().min(1),
});
export type TenantContext = z.infer<typeof TenantContext>;

// ---------------------------------------------------------------------------
// OrgLessContext

/**
 * A signed-in person acting outside any org. No membership, so no role. Impersonation always
 * happens inside an org, so there is no impersonator here.
 */
export const OrgLessUserActor = z.strictObject({
  type: z.literal("user"),
  userId: UserId,
  /** users.platform_role. The platform_* operations need "superadmin". */
  platformRole: PlatformRole.nullable(),
});
export type OrgLessUserActor = z.infer<typeof OrgLessUserActor>;

/**
 * The context for operations that run without an org: `org.create` (any signed-in user, even one
 * with no membership) and the platform_* operations. Session only, so the actor is always a user.
 * Their audit rows have org_id null (AuditStore.appendOrgLess).
 */
export const OrgLessContext = z.strictObject({
  orgId: z.null(),
  actor: OrgLessUserActor,
  /** "console" for Server Actions, "api" for cookie calls to /api/v1. */
  client: z.enum(["console", "api"]),
  requestId: z.string().min(1),
});
export type OrgLessContext = z.infer<typeof OrgLessContext>;

/** What an operation handler receives: an org context, or for org-less operations either kind. */
export const OperationContext = z.union([TenantContext, OrgLessContext]);
export type OperationContext = z.infer<typeof OperationContext>;

// ---------------------------------------------------------------------------
// PublishCtx

/** A channel checked for interface.breaking. */
export const PublishServedChannel = z.strictObject({
  channel: PointerChannel,
  interface: SetInterface,
  interfaceMajor: z.number().int().nonnegative(),
  /** Live bindings, or app runs on that channel in the last 30 days. */
  hasConsumers: z.boolean(),
});
export type PublishServedChannel = z.infer<typeof PublishServedChannel>;

/**
 * What publish-time lints read. The operation builds it from the stores; core never reads them.
 */
export const PublishCtx = z.strictObject({
  /** The target channel. */
  channel: PointerChannel,
  /** The target's stage; "inactive" when it has no pointer yet. */
  rolloutStage: RolloutStage,
  /**
   * Channels to check for interface.breaking: the target, plus production when the target is
   * staging. One entry per channel that has a pointer.
   */
  served: z.array(PublishServedChannel),
  /**
   * publish: the set's highest major, plus one with interfaceBump.
   * promote: the promoted version's stored major.
   */
  newMajor: z.number().int().nonnegative(),
  /** The provider the set's runs use. */
  systemOneProvider: SystemOneProvider,
  /** org_system_one_keys.models for that provider, as registry ids. */
  reachableModels: z.array(z.string()),
  /**
   * Route rows for that provider (empty for typesafe). model.alias_past_shadow and
   * model.not_available_to_org call resolveRoute with them, so a route that is not pinned counts
   * as moving.
   */
  modelRoutes: z.array(ModelRoute),
  /**
   * Exact model ids with a price_books row the org can read (its own rows plus the platform rows).
   * Lint `escalation.model_unpriced` checks EscalationConfig.model against it.
   */
  pricedModels: z.array(z.string().min(1)),
  allowPreviewModels: z.boolean(),
  /** Action handlers installed and enabled for the org. */
  enabledHandlers: z.array(z.string()),
  /** Sets this spec names as fallbacks. A missing key means no such set. */
  fallbackSets: z.record(z.string(), z.strictObject({ usesSetFallback: z.boolean() })),
  /** The set stores hashes only. */
  hashOnly: z.boolean(),
});
export type PublishCtx = z.infer<typeof PublishCtx>;
