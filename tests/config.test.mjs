import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getConfigPath,
  loadConfig,
  parseConfigKey,
  parseConfigValue,
  saveConfig,
  setConfigValue,
} from "../dist/config/load-config.js";
import { DEFAULT_CONFIG } from "../dist/config/schema.js";

async function withConfigHome(run) {
  const previousHome = process.env.SOLARCIDO_HOME;
  const home = await mkdtemp(path.join(tmpdir(), "solarcido-config-test-"));
  process.env.SOLARCIDO_HOME = home;

  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.SOLARCIDO_HOME;
    } else {
      process.env.SOLARCIDO_HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test("loadConfig returns defaults when config is missing", async () => {
  await withConfigHome(async () => {
    assert.deepEqual(await loadConfig(), DEFAULT_CONFIG);
  });
});

test("loadConfig merges partial config with defaults", async () => {
  await withConfigHome(async (home) => {
    await mkdir(home, { recursive: true });
    await writeFile(getConfigPath(), JSON.stringify({ model: "solar-custom", maxSteps: 4 }), "utf8");

    assert.deepEqual(await loadConfig(), {
      ...DEFAULT_CONFIG,
      model: "solar-custom",
      maxSteps: 4,
    });
  });
});

test("loadConfig rejects unknown keys", async () => {
  await withConfigHome(async (home) => {
    await mkdir(home, { recursive: true });
    await writeFile(getConfigPath(), JSON.stringify({ unknown: true }), "utf8");

    await assert.rejects(() => loadConfig(), /Unknown config key/);
  });
});

test("parseConfigValue validates typed config values", () => {
  assert.equal(parseConfigValue("reasoningEffort", "high"), "high");
  assert.equal(parseConfigValue("maxSteps", "5"), 5);
  assert.equal(parseConfigValue("quiet", "true"), true);
  assert.throws(() => parseConfigValue("sandbox", "danger-full-access"), /sandbox must be/);
});

test("setConfigValue updates a single key", () => {
  assert.deepEqual(setConfigValue(DEFAULT_CONFIG, "model", "solar-test"), {
    ...DEFAULT_CONFIG,
    model: "solar-test",
  });
});

test("parseConfigKey rejects unknown keys", () => {
  assert.throws(() => parseConfigKey("missing"), /Unknown config key/);
});
