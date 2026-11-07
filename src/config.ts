import { readFileSync } from "node:fs";

export interface Config {
  name: string;
  greeting: string;
  bio: string[];
  owners: "auto" | string[];
  includePrivate: boolean;
  excludeRepos: string[];
  excludeLanguages: string[];
  languages: number;
  tokenmaxxing: string | null;
  models: number;
}

const DEFAULTS: Config = {
  name: "",
  greeting: "hi, i’m",
  bio: [],
  owners: "auto",
  includePrivate: true,
  excludeRepos: [],
  excludeLanguages: [],
  languages: 7,
  tokenmaxxing: null,
  models: 5,
};

// The legends have 8 and 6 slots, one of which is always "Other".
const LIMITS = { languages: 7, models: 5 } as const;

export function loadConfig(path: string): Config {
  const { $schema: _, ...raw } = JSON.parse(readFileSync(path, "utf8"));
  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULTS));
  if (unknown.length) throw new Error(`Unknown config keys in ${path}: ${unknown.join(", ")}`);

  const config: Config = { ...DEFAULTS, ...raw };
  for (const key of ["languages", "models"] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > LIMITS[key]) {
      throw new Error(`"${key}" must be an integer from 1 to ${LIMITS[key]}`);
    }
  }
  if (config.owners !== "auto" && (!Array.isArray(config.owners) || config.owners.length === 0)) {
    throw new Error(`"owners" must be "auto" or a non-empty list of users and organizations`);
  }
  return config;
}
