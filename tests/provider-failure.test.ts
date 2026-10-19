import { expect, it } from "vitest";
import { providerFailure } from "../src/provider-failure.ts";
it("keeps only allowlisted provider classifications, never messages or arbitrary fields", async () => {
  const error = await providerFailure(
    Response.json(
      {
        error: {
          code: "unsupported_value",
          param: "reasoning_effort",
          message: "PRIVATE_DATA",
          secret: "PRIVATE_DATA",
        },
      },
      { status: 400 },
    ),
  );
  expect(error.providerStatus).toBe(400);
  expect(error.providerCode).toBe("unsupported_value");
  expect(error.providerParam).toBe("reasoning_effort");
  expect(JSON.stringify(error)).not.toContain("PRIVATE_DATA");
});
it("redacts unknown code/parameter, malformed and oversized body", async () => {
  const unknown = await providerFailure(
    Response.json(
      { error: { code: "PRIVATE_DATA", param: "PRIVATE_DATA" } },
      { status: 429 },
    ),
  );
  expect(unknown.providerCode).toBe("unclassified");
  expect(unknown.providerParam).toBeNull();
  for (const body of ["bad json", "x".repeat(20000)])
    expect(
      (await providerFailure(new Response(body, { status: 500 }))).providerCode,
    ).toBe("unclassified");
});
