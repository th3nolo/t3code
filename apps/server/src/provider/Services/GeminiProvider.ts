import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface GeminiProviderShape extends ServerProviderShape {}

export class GeminiProvider extends Context.Service<GeminiProvider, GeminiProviderShape>()(
  "t3/provider/Services/GeminiProvider",
) {}
