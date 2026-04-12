import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigSchema, type Config } from "./schema";

/**
 * Resolve the path to config.yaml.
 *
 * Priority:
 *   1. ESPRESENSE_CONFIG_PATH env var (absolute or relative to cwd)
 *   2. ./config.yaml in the current working directory
 */
export function resolveConfigPath(): string {
  const fromEnv = process.env.ESPRESENSE_CONFIG_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.resolve(process.cwd(), "config.yaml");
}

export class ConfigNotFoundError extends Error {
  constructor(public readonly configPath: string) {
    super(`Config file not found at ${configPath}`);
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigParseError extends Error {
  constructor(
    message: string,
    public readonly configPath: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigParseError";
  }
}

/** Parse a YAML string into a validated Config object. */
export function parseConfig(yaml: string, source = "<string>"): Config {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    throw new ConfigParseError(
      `Failed to parse YAML in ${source}: ${(err as Error).message}`,
      source,
      err,
    );
  }

  // Treat empty file / null document as an empty object so defaults apply.
  if (raw == null) raw = {};

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigParseError(
      `Invalid config in ${source}:\n${formatZodError(result.error)}`,
      source,
      result.error,
    );
  }
  return result.data;
}

/** Read and parse the config file from disk. */
export async function loadConfig(configPath?: string): Promise<Config> {
  const resolved = configPath ?? resolveConfigPath();
  let contents: string;
  try {
    contents = await readFile(resolved, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new ConfigNotFoundError(resolved);
    }
    throw err;
  }
  return parseConfig(contents, resolved);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const p =
        issue.path.length > 0
          ? issue.path.map((segment) => String(segment)).join(".")
          : "(root)";
      return `  - ${p}: ${issue.message}`;
    })
    .join("\n");
}
