import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  acpPermissionOutcome,
  isAcpMethodNotFound,
  mapAcpToAdapterError,
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
});
