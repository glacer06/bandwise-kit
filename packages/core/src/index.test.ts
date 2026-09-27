import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import * as contracts from "./contracts/index.js";

describe("@bandwise/core", () => {
  it("loads the root and contracts entrypoints", () => {
    expect(core).toBeTypeOf("object");
    expect(contracts).toBeTypeOf("object");
  });
});
