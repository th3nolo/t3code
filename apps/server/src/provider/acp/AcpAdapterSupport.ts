import {
  type ProviderApprovalDecision,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { Schema } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { Effect } from "effect";

export function mapAcpToAdapterError(
  provider: ProviderKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function isAcpMethodNotFound(
  error: EffectAcpErrors.AcpError,
): error is EffectAcpErrors.AcpRequestError {
  return Schema.is(EffectAcpErrors.AcpRequestError)(error) && error.code === -32601;
}

export type OptionalAcpCallResult<A> =
  | { readonly _tag: "applied"; readonly value: A }
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "failed"; readonly error: EffectAcpErrors.AcpError };

export const tolerateOptionalAcpCall = <A>(input: {
  readonly label: string;
  readonly effect: Effect.Effect<A, EffectAcpErrors.AcpError>;
}): Effect.Effect<OptionalAcpCallResult<A>, never> =>
  input.effect.pipe(
    Effect.map((value): OptionalAcpCallResult<A> => ({ _tag: "applied", value })),
    Effect.catch((error) =>
      isAcpMethodNotFound(error)
        ? Effect.logDebug(`ACP ${input.label}: method not implemented, will retry later`).pipe(
            Effect.as<OptionalAcpCallResult<A>>({ _tag: "unsupported" }),
          )
        : Effect.logWarning(`ACP ${input.label} failed, will retry later`, {
            error: error.message,
          }).pipe(Effect.as<OptionalAcpCallResult<A>>({ _tag: "failed", error })),
    ),
  );

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
