import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadConfig } from "./config.ts";
import { type ContributionCache, fetchGitHub, type GitHubStats } from "./github.ts";
import { THEMES, renderProfile } from "./render.ts";
import { type AiStats, fetchTokenmaxxing } from "./tokenmaxxing.ts";

interface Output {
  generatedAt: string;
  github: Omit<GitHubStats, "avatar">;
  ai: AiStats | null;
}

const root = join(import.meta.dirname, "..");
const config = loadConfig(resolve(process.env.CONFIG ?? join(root, "config.json")));
const token = process.env.ACCESS_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error("Set ACCESS_TOKEN to a GitHub token (see README.md)");

const outDir = resolve(process.env.OUT_DIR ?? join(root, "out"));
mkdirSync(outDir, { recursive: true });
const readJson = <T>(file: string): T | null =>
  existsSync(join(outDir, file)) ? JSON.parse(readFileSync(join(outDir, file), "utf8")) : null;
const previous = readJson<Output>("stats.json");

// tokenmaxxing is optional, so an outage there reuses yesterday's numbers instead of failing the run.
async function loadAi(): Promise<AiStats | null> {
  if (!config.tokenmaxxing) return null;
  try {
    return await fetchTokenmaxxing(config.tokenmaxxing);
  } catch (error) {
    console.warn(`tokenmaxxing failed, keeping previous data: ${error}`);
    return previous?.ai ?? null;
  }
}

const started = performance.now();
const [{ stats: github, cache }, ai] = await Promise.all([
  fetchGitHub(config, token, readJson<ContributionCache>("cache.json")),
  loadAi(),
]);

const { avatar: _, ...githubData } = github;
const output: Output = { generatedAt: new Date().toISOString(), github: githubData, ai };
writeFileSync(join(outDir, "profile.svg"), renderProfile(config, github, ai, THEMES.light));
writeFileSync(join(outDir, "profile-dark.svg"), renderProfile(config, github, ai, THEMES.dark));
writeFileSync(join(outDir, "stats.json"), `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(join(outDir, "cache.json"), `${JSON.stringify(cache, null, 2)}\n`);

const cachedYears = Object.keys(cache.years).length;
console.log(
  `Generated ${outDir} in ${Math.round(performance.now() - started)} ms ` +
    `(${github.repos} repos, ${github.contributions} contributions, ${cachedYears} finished years cached)`,
);
