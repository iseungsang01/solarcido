import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  type ConfigKey,
  type SolarcidoConfig,
  isConfigKey,
} from "./schema.js";

export function getSolarcidoHome(): string {
  return path.resolve(process.env.SOLARCIDO_HOME ?? path.join(os.homedir(), ".solarcido"));
}

export function getConfigPath(): string {
  return path.join(getSolarcidoHome(), "config.json");
}

export async function loadConfig(): Promise<SolarcidoConfig> {
  const configPath = getConfigPath();

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return DEFAULT_CONFIG;
    }

    throw new Error(`Could not read config at ${configPath}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${errorMessage(error)}`);
  }

  return validateConfig(parsed, configPath);
}

export async function saveConfig(config: SolarcidoConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getConfigValue(config: SolarcidoConfig, key?: ConfigKey): unknown {
  if (!key) {
    return config;
  }

  return config[key];
}

export function parseConfigValue(key: ConfigKey, rawValue: string): SolarcidoConfig[ConfigKey] {
  switch (key) {
    case "model":
      if (!rawValue.trim()) {
        throw new Error("model must not be empty.");
      }
      return rawValue.trim();
    case "reasoningEffort":
      if (rawValue === "low" || rawValue === "medium" || rawValue === "high") {
        return rawValue;
      }
      throw new Error("reasoningEffort must be low, medium, or high.");
    case "maxSteps": {
      const value = Number(rawValue);
      if (Number.isInteger(value) && value >= 1) {
        return value;
      }
      throw new Error("maxSteps must be a positive integer.");
    }
    case "approvalPolicy":
      if (rawValue === "never" || rawValue === "on-failure" || rawValue === "on-request") {
        return rawValue;
      }
      throw new Error("approvalPolicy must be never, on-failure, or on-request.");
    case "sandbox":
      if (rawValue === "read-only" || rawValue === "workspace-write") {
        return rawValue;
      }
      throw new Error("sandbox must be read-only or workspace-write.");
    case "quiet":
      if (rawValue === "true") return true;
      if (rawValue === "false") return false;
      throw new Error("quiet must be true or false.");
  }
}

export function setConfigValue(config: SolarcidoConfig, key: ConfigKey, value: SolarcidoConfig[ConfigKey]): SolarcidoConfig {
  return {
    ...config,
    [key]: value,
  };
}

export function parseConfigKey(rawKey: string): ConfigKey {
  if (isConfigKey(rawKey)) {
    return rawKey;
  }

  throw new Error(`Unknown config key: ${rawKey}. Valid keys: ${CONFIG_KEYS.join(", ")}`);
}

function validateConfig(value: unknown, configPath: string): SolarcidoConfig {
  if (!isRecord(value)) {
    throw new Error(`Config at ${configPath} must be a JSON object.`);
  }

  for (const key of Object.keys(value)) {
    if (!isConfigKey(key)) {
      throw new Error(`Unknown config key in ${configPath}: ${key}. Valid keys: ${CONFIG_KEYS.join(", ")}`);
    }
  }

  const config = { ...DEFAULT_CONFIG };

  for (const key of CONFIG_KEYS) {
    if (value[key] !== undefined) {
      config[key] = validateConfigField(key, value[key]) as never;
    }
  }

  return config;
}

function validateConfigField(key: ConfigKey, value: unknown): SolarcidoConfig[ConfigKey] {
  switch (key) {
    case "model":
      if (typeof value === "string" && value.trim()) return value;
      throw new Error("model must be a non-empty string.");
    case "reasoningEffort":
      if (value === "low" || value === "medium" || value === "high") return value;
      throw new Error("reasoningEffort must be low, medium, or high.");
    case "maxSteps":
      if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
      throw new Error("maxSteps must be a positive integer.");
    case "approvalPolicy":
      if (value === "never" || value === "on-failure" || value === "on-request") return value;
      throw new Error("approvalPolicy must be never, on-failure, or on-request.");
    case "sandbox":
      if (value === "read-only" || value === "workspace-write") return value;
      throw new Error("sandbox must be read-only or workspace-write.");
    case "quiet":
      if (typeof value === "boolean") return value;
      throw new Error("quiet must be a boolean.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
