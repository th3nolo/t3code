import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GeminiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "gemini";
}

export class GeminiAdapter extends Context.Service<GeminiAdapter, GeminiAdapterShape>()(
  "t3/provider/Services/GeminiAdapter",
) {}
