import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  acpPermissionOutcome,
  isAcpMethodNotFound,
  mapAcpToAdapterError,
  tolerateOptionalAcpCall,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      "cursor",
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  describe("isAcpMethodNotFound", () => {
    it("returns true for AcpRequestError with code -32601", () => {
      expect(isAcpMethodNotFound(EffectAcpErrors.AcpRequestError.methodNotFound("foo"))).toBe(true);
      expect(
        isAcpMethodNotFound(
          new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "anything",
          }),
        ),
      ).toBe(true);
    });

    it("returns false for AcpRequestError with other codes", () => {
      expect(isAcpMethodNotFound(EffectAcpErrors.AcpRequestError.invalidRequest("bad"))).toBe(
        false,
      );
      expect(isAcpMethodNotFound(EffectAcpErrors.AcpRequestError.invalidParams("bad"))).toBe(false);
      expect(isAcpMethodNotFound(EffectAcpErrors.AcpRequestError.internalError("bad"))).toBe(false);
    });

    it("returns false for non-request ACP errors", () => {
      expect(
        isAcpMethodNotFound(
          new EffectAcpErrors.AcpProcessExitedError({ code: 1, cause: new Error("x") }),
        ),
      ).toBe(false);
      expect(
        isAcpMethodNotFound(new EffectAcpErrors.AcpProtocolParseError({ detail: "bad" })),
      ).toBe(false);
    });
  });

  describe("tolerateOptionalAcpCall", () => {
    it("returns applied on success", async () => {
      const result = await Effect.runPromise(
        tolerateOptionalAcpCall({
          label: "session/set_mode",
          effect: Effect.succeed("ok"),
        }),
      );

      expect(result).toEqual({ _tag: "applied", value: "ok" });
    });

    it("returns unsupported for method-not-found ACP errors", async () => {
      const result = await Effect.runPromise(
        tolerateOptionalAcpCall({
          label: "session/set_mode",
          effect: Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound("session/set_mode")),
        }),
      );

      expect(result).toEqual({ _tag: "unsupported" });
    });

    it("returns failed for non-method-not-found ACP errors", async () => {
      const error = EffectAcpErrors.AcpRequestError.invalidParams("bad");
      const result = await Effect.runPromise(
        tolerateOptionalAcpCall({
          label: "session/set_mode",
          effect: Effect.fail(error),
        }),
      );

      expect(result).toEqual({ _tag: "failed", error });
    });
  });
});
