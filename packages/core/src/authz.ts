// can(ctx, action, resource): the role and scope matrix every operation checks through
// runOperation.
//
// The matrix is the operation catalog (OPERATION_CATALOG): each row's scope, floor role and
// actors. can() adds the resource rules: org and set allowlist (404, never 403, across orgs), app
// token channel and mode, publishable tokens being run-only, and the raises to admin for protected
// sets, entering full and skipExperiment. RLS stays the backstop.

import type { PointerChannel, Role, RolloutStage, Scope } from "./contracts/common.js";
import { ROLE_ORDER } from "./contracts/common.js";
import type { OperationId } from "./contracts/operations.js";
import { catalogActors, catalogEntry, runsWithoutOrg } from "./contracts/operations.js";
import type { OrgLessContext, TenantContext } from "./contracts/tenant.js";

/** What can() needs to know about the resource an operation touches. Omit what does not apply. */
export interface AuthzResource {
  /** The org that owns the resource. Another org's resource is 404. */
  orgId: string;
  /** The set, for set allowlists on app and agent tokens. */
  setId?: string | null;
  /** The channel, for release:<channel> scopes and an app token's bound channel. */
  channel?: PointerChannel;
  /** question_sets.protected: publishing or promoting it needs an admin. */
  protected?: boolean;
  /** rollout.change: the current and target stages. Entering full needs an admin. */
  rolloutFrom?: RolloutStage | null;
  rolloutTo?: RolloutStage;
  /** set.publish and channel.promote with skipExperiment need an admin. */
  skipExperiment?: boolean;
  /** A slug@draft run: app tokens need test mode (sk_test_). */
  draft?: boolean;
  /** set.codegen target: standalone is sessions and agent tokens only, editor role. */
  codegenTarget?: string;
  /** approval.decide: the role the requested operation needs. */
  requiredRole?: Role;
}

export type AuthzDecision =
  | { allowed: true }
  | { allowed: false; code: "not_found" | "insufficient_scope"; requiredScope?: Scope; reason: string };

const ALLOW: AuthzDecision = { allowed: true };
const notFound = (reason: string): AuthzDecision => ({ allowed: false, code: "not_found", reason });
const forbidden = (reason: string, requiredScope?: Scope): AuthzDecision =>
  requiredScope === undefined
    ? { allowed: false, code: "insufficient_scope", reason }
    : { allowed: false, code: "insufficient_scope", requiredScope, reason };

/** True when `role` is at least `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_ORDER.indexOf(role) <= ROLE_ORDER.indexOf(min);
}

/** The lower of two roles: an agent token's effective role is min(role ceiling, membership role). */
export function minRole(a: Role, b: Role): Role {
  return roleAtLeast(a, b) ? b : a;
}

const RAISED_BY_PROTECTED: readonly OperationId[] = ["set.publish", "channel.promote"];

/** The scope a catalog row needs for this resource, or null when any actor in the org may call it. */
function requiredScopeOf(scope: string, channel: PointerChannel | undefined): Scope | null {
  if (scope === "release:<channel>") return `release:${channel ?? "production"}`;
  if (scope === "any" || scope === "session_only" || scope === "platform_admin") return null;
  return scope as Scope;
}

/** The floor role after the resource raises (protected sets, entering full, skipExperiment, standalone codegen). */
function floorRole(action: OperationId, catalogMin: string, r: AuthzResource | null): Role | null {
  let floor: Role | null = catalogMin === "requested_operation" ? (r?.requiredRole ?? "admin") : ROLE_ORDER.includes(catalogMin as Role) ? (catalogMin as Role) : null;
  const raise = (to: Role): void => {
    if (floor === null || !roleAtLeast(floor, to)) floor = to;
  };
  if (r?.protected === true && RAISED_BY_PROTECTED.includes(action)) raise("admin");
  if (r?.skipExperiment === true) raise("admin");
  if (action === "rollout.change" && r?.rolloutTo === "full" && r.rolloutFrom !== "full") raise("admin");
  if (action === "set.codegen" && r?.codegenTarget === "standalone") raise("editor");
  return floor;
}

/**
 * Whether the actor in `ctx` may run `action` on `resource`. A denial is `not_found` for anything
 * outside the caller's org or set allowlist (and for platform routes), and `insufficient_scope`
 * for a resource the caller can see but may not touch.
 */
export function can(ctx: TenantContext | OrgLessContext, action: OperationId, resource: AuthzResource | null): AuthzDecision {
  const entry = catalogEntry(action);
  if (entry.scope === "platform_admin") {
    const a = ctx.actor;
    return a.type === "user" && a.platformRole === "superadmin" ? ALLOW : notFound("platform routes need a platform admin");
  }
  if (ctx.orgId === null) {
    return runsWithoutOrg(entry) ? ALLOW : notFound("this operation needs an org");
  }
  const actor = ctx.actor;
  if (resource !== null && resource.orgId !== ctx.orgId) return notFound("the resource belongs to another org");

  const actors: string[] = catalogActors(entry);
  if (!actors.includes(actor.type)) {
    return forbidden(entry.scope === "session_only" ? "this operation needs a console session" : `a ${actor.type} actor cannot call ${action}`);
  }
  if (actor.type === "system") return ALLOW;

  const setId = resource?.setId;
  if ((actor.type === "apiKey" || actor.type === "agent") && actor.setIds !== null && setId !== undefined && setId !== null) {
    if (!actor.setIds.includes(setId)) return notFound("the set is outside the token's allowlist");
  }

  const required = requiredScopeOf(entry.scope, resource?.channel);
  if (required !== null && actor.type !== "user" && !actor.scopes.includes(required)) {
    return forbidden(`the token lacks the ${required} scope`, required);
  }

  if (actor.type === "apiKey") {
    if (actor.tokenKind !== "secret" && action !== "set.run") return forbidden("publishable and browser tokens can only run sets", "run");
    if (resource?.channel !== undefined && resource.channel !== actor.channel) {
      return forbidden(`the token is bound to the ${actor.channel} channel`);
    }
    if (resource?.draft === true && actor.mode !== "test") return forbidden("slug@draft runs need an sk_test_ token");
    if (action === "set.codegen" && resource?.codegenTarget === "standalone") {
      return forbidden("standalone export is for console sessions and agent tokens");
    }
    return ALLOW;
  }

  const floor = floorRole(action, entry.minRole, resource);
  if (floor !== null && !roleAtLeast(actor.role, floor)) return forbidden(`${action} needs the ${floor} role`);
  return ALLOW;
}
