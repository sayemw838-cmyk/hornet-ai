import assert from "node:assert/strict";
import test from "node:test";
import { createModelProviderFromEnv } from "../src/adapters/model-provider.js";

test("model execution is disabled by default and cannot assume missing prices are free", () => {
  assert.equal(createModelProviderFromEnv({}), null);
  assert.throws(() => createModelProviderFromEnv({
    HORNET_MODEL_PROVIDER: "openai-compatible",
    HORNET_MODEL_BASE_URL: "https://api.example.test/v1",
    HORNET_MODEL_ID: "model",
    HORNET_MODEL_API_KEY: "injected-secret",
    HORNET_MODEL_BILLING_APPROVED: "true",
    HORNET_MODEL_MAX_CALLS_PER_RUN: "2",
    HORNET_MODEL_MAX_INPUT_TOKENS: "1000",
    HORNET_MODEL_MAX_OUTPUT_TOKENS: "500",
    HORNET_MODEL_MAX_COST_USD_PER_RUN: "0.1",
  }), /Explicit non-negative token prices and a per-run budget/);
});

test("provider activation requires explicit operator approval and bounded usage", () => {
  const config = { HORNET_MODEL_PROVIDER: "openai-compatible", HORNET_MODEL_BASE_URL: "https://api.example.test/v1", HORNET_MODEL_ID: "model", HORNET_MODEL_API_KEY: "injected-secret", HORNET_MODEL_INPUT_USD_PER_MILLION_TOKENS: "0", HORNET_MODEL_OUTPUT_USD_PER_MILLION_TOKENS: "0", HORNET_MODEL_MAX_COST_USD_PER_RUN: "0", HORNET_MODEL_MAX_CALLS_PER_RUN: "3", HORNET_MODEL_MAX_INPUT_TOKENS: "1000", HORNET_MODEL_MAX_OUTPUT_TOKENS: "500" };
  assert.throws(() => createModelProviderFromEnv(config), /explicitly enables/);
  const provider = createModelProviderFromEnv({ ...config, HORNET_MODEL_BILLING_APPROVED: "true" }, async () => { throw new Error("should not be contacted in this test"); });
  assert.equal(provider.provider, "openai-compatible");
});
