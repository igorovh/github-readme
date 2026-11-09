import type { Config } from "./config.ts";

export interface GitHubStats {
  login: string;
  name: string;
  avatar: { mime: string; data: string } | null;
  contributions: number;
  commits: number;
  pullRequests: number;
  issues: number;
  reviews: number;
  stars: number;
  forks: number;
  repos: number;
  activeDays: number;
  longestStreak: number;
  languages: [string, number][];
}

interface YearTotals {
  commits: number;
  pullRequests: number;
  issues: number;
  reviews: number;
  created: number;
  // Private contributions arrive as one count without repositories, so owner filters cannot apply.
  restricted: number;
  repos: string[];
  activeDays: string[];
}

export interface ContributionCache {
  key: string;
  savedAt: string;
  years: Record<string, YearTotals>;
}

interface RepoRef {
  nameWithOwner: string;
  isPrivate: boolean;
}

interface ByRepo {
  repository: RepoRef;
  contributions: { totalCount: number };
}

interface RepoDetails {
  isFork: boolean;
  stargazerCount: number;
  forkCount: number;
  languages: { edges: { size: number; node: { name: string } }[] };
}

const MS_DAY = 86_400_000;
const CACHE_TTL_DAYS = 30;
// Small parallel queries return much faster than one large query (60 repos: ~1.1 s vs ~3.2 s).
const DETAILS_CHUNK = 10;

type Gql = <T>(query: string, variables?: Record<string, unknown>, partial?: boolean) => Promise<T>;

function client(token: string): Gql {
  return async (query, variables = {}, partial = false) => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "github-readme" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
    const json = await res.json();
    // Partial queries tolerate repos that were deleted or became inaccessible.
    if (json.errors && !(partial && json.data)) throw new Error(`GitHub API error: ${JSON.stringify(json.errors)}`);
    return json.data;
  };
}

const glob = (pattern: string) =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

const REPO = "repository { nameWithOwner isPrivate }";
const BY_REPO = `${REPO} contributions { totalCount }`;

const YEAR_FIELDS = `
  restrictedContributionsCount
  commitContributionsByRepository(maxRepositories: 100) { ${BY_REPO} }
  pullRequestContributionsByRepository(maxRepositories: 100) { ${BY_REPO} }
  issueContributionsByRepository(maxRepositories: 100) { ${BY_REPO} }
  pullRequestReviewContributionsByRepository(maxRepositories: 100) { ${BY_REPO} }
  repositoryContributions(first: 100) { nodes { ${REPO} } }
  contributionCalendar { weeks { contributionDays { date contributionCount } } }`;

interface YearCollection {
  restrictedContributionsCount: number;
  contributionCalendar: { weeks: { contributionDays: { date: string; contributionCount: number }[] }[] };
  commitContributionsByRepository: ByRepo[];
  pullRequestContributionsByRepository: ByRepo[];
  issueContributionsByRepository: ByRepo[];
  pullRequestReviewContributionsByRepository: ByRepo[];
  repositoryContributions: { nodes: { repository: RepoRef }[] };
}

const yearRange = (year: number) => ({ from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` });

async function fetchYear(gql: Gql, year: number): Promise<YearCollection> {
  const { viewer } = await gql<{ viewer: { contributionsCollection: YearCollection } }>(
    `query($from: DateTime!, $to: DateTime!) { viewer { contributionsCollection(from: $from, to: $to) { ${YEAR_FIELDS} } } }`,
    yearRange(year),
  );
  return viewer.contributionsCollection;
}

function sumYear(c: YearCollection, keep: (repo: RepoRef) => boolean): YearTotals {
  const repos = new Set<string>();
  const sum = (list: ByRepo[]) =>
    list
      .filter((item) => keep(item.repository))
      .reduce((total, item) => {
        repos.add(item.repository.nameWithOwner);
        return total + item.contributions.totalCount;
      }, 0);
  return {
    commits: sum(c.commitContributionsByRepository),
    pullRequests: sum(c.pullRequestContributionsByRepository),
    issues: sum(c.issueContributionsByRepository),
    reviews: sum(c.pullRequestReviewContributionsByRepository),
    created: c.repositoryContributions.nodes.filter((n) => keep(n.repository)).length,
    restricted: c.restrictedContributionsCount,
    repos: [...repos],
    // The calendar includes private contributions, so active days and streaks match the profile.
    activeDays: c.contributionCalendar.weeks
      .flatMap((w) => w.contributionDays)
      .filter((d) => d.contributionCount > 0)
      .map((d) => d.date),
  };
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string };
}

async function paginate<T>(fetchPage: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

const fetchRepos = (gql: Gql, privacy: "PUBLIC" | null) =>
  paginate<RepoRef>(async (cursor) => {
    const { viewer } = await gql<{ viewer: { repositories: Page<RepoRef> } }>(
      `query($cursor: String, $privacy: RepositoryPrivacy) { viewer {
        repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false, privacy: $privacy) {
          nodes { nameWithOwner isPrivate } pageInfo { hasNextPage endCursor } } } }`,
      { cursor, privacy },
    );
    return viewer.repositories;
  });

// viewer.repositories skips org repos reached through org admin rights, so each owner is listed directly.
const fetchPrivateRepos = (gql: Gql, owner: string) =>
  paginate<RepoRef>(async (cursor) => {
    const { repositoryOwner } = await gql<{ repositoryOwner: { repositories: Page<RepoRef> } | null }>(
      `query($owner: String!, $cursor: String) { repositoryOwner(login: $owner) {
        repositories(first: 100, after: $cursor, isFork: false, privacy: PRIVATE) {
          nodes { nameWithOwner isPrivate } pageInfo { hasNextPage endCursor } } } }`,
      { owner, cursor },
    );
    return repositoryOwner?.repositories ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: "" } };
  });

// Includes private pull requests, which contributionsCollection only reports as a restricted count.
const fetchPullRequests = (gql: Gql) =>
  paginate<{ repository: RepoRef }>(async (cursor) => {
    const { viewer } = await gql<{ viewer: { pullRequests: Page<{ repository: RepoRef }> } }>(
      `query($cursor: String) { viewer { pullRequests(first: 100, after: $cursor) {
        nodes { ${REPO} } pageInfo { hasNextPage endCursor } } } }`,
      { cursor },
    );
    return viewer.pullRequests;
  });

// Counts default-branch commits like the contribution calendar does, but per private repo.
async function countCommits(gql: Gql, authorId: string, names: string[]): Promise<number> {
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += DETAILS_CHUNK) chunks.push(names.slice(i, i + DETAILS_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => {
      const fields = chunk.map((full, i) => {
        const [owner, name] = full.split("/");
        return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          defaultBranchRef { target { ... on Commit { history(author: { id: $author }) { totalCount } } } } }`;
      });
      type Counted = { defaultBranchRef: { target: { history?: { totalCount: number } } } | null } | null;
      return gql<Record<string, Counted>>(`query($author: ID!) { ${fields.join("\n")} }`, { author: authorId }, true);
    }),
  );
  return results
    .flatMap((data) => Object.values(data))
    .reduce((sum, repo) => sum + (repo?.defaultBranchRef?.target.history?.totalCount ?? 0), 0);
}

function longestStreak(dates: string[]): number {
  let best = 0;
  let current = 0;
  let previous = Number.NaN;
  for (const time of dates.map(Date.parse).sort((a, b) => a - b)) {
    current = time - previous === MS_DAY ? current + 1 : 1;
    best = Math.max(best, current);
    previous = time;
  }
  return best;
}

async function fetchRepoDetails(gql: Gql, names: string[]): Promise<RepoDetails[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < names.length; i += DETAILS_CHUNK) chunks.push(names.slice(i, i + DETAILS_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => {
      const fields = chunk.map((full, i) => {
        const [owner, name] = full.split("/");
        return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          isFork stargazerCount forkCount languages(first: 30) { edges { size node { name } } } }`;
      });
      return gql<Record<string, RepoDetails | null>>(`{ ${fields.join("\n")} }`, {}, true);
    }),
  );
  return results.flatMap((data) => Object.values(data)).filter((r): r is RepoDetails => r !== null && !r.isFork);
}

async function fetchAvatar(url: string): Promise<GitHubStats["avatar"]> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const mime = res.headers.get("content-type") ?? "image/png";
  return { mime, data: Buffer.from(await res.arrayBuffer()).toString("base64") };
}

export async function fetchGitHub(
  config: Config,
  token: string,
  cache: ContributionCache | null,
): Promise<{ stats: GitHubStats; cache: ContributionCache }> {
  const gql = client(token);
  const currentYear = new Date().getUTCFullYear();
  // The current year rides along with the profile query, and the repo lists do not depend on it.
  const [{ viewer }, owned, pullRequests] = await Promise.all([
    gql<{
      viewer: {
        id: string;
        login: string;
        name: string | null;
        avatarUrl: string;
        organizations: { nodes: { login: string }[] };
        years: { contributionYears: number[] };
        current: YearCollection;
      };
    }>(
      `query($from: DateTime!, $to: DateTime!) { viewer { id login name avatarUrl(size: 256)
        organizations(first: 100) { nodes { login } }
        years: contributionsCollection { contributionYears }
        current: contributionsCollection(from: $from, to: $to) { ${YEAR_FIELDS} } } }`,
      yearRange(currentYear),
    ),
    fetchRepos(gql, config.includePrivate ? null : "PUBLIC"),
    fetchPullRequests(gql),
  ]);

  const owners = new Set(
    (config.owners === "auto" ? [viewer.login, ...viewer.organizations.nodes.map((o) => o.login)] : config.owners).map(
      (o) => o.toLowerCase(),
    ),
  );
  const excluded = config.excludeRepos.map(glob);
  const keep = (repo: RepoRef) =>
    owners.has(repo.nameWithOwner.split("/")[0].toLowerCase()) &&
    (config.includePrivate || !repo.isPrivate) &&
    !excluded.some((re) => re.test(repo.nameWithOwner));

  // Finished years rarely change, so they are reused until the settings change or the cache expires.
  const key = JSON.stringify({
    version: 3,
    login: viewer.login,
    owners: [...owners].sort(),
    includePrivate: config.includePrivate,
    excludeRepos: config.excludeRepos,
  });
  const valid = cache?.key === key && Date.now() - Date.parse(cache.savedAt) < CACHE_TTL_DAYS * MS_DAY;
  const years: Record<string, YearTotals> = { [currentYear]: sumYear(viewer.current, keep) };
  const avatarPromise = fetchAvatar(viewer.avatarUrl);
  const privatePromise = config.includePrivate
    ? Promise.all([...owners].map((owner) => fetchPrivateRepos(gql, owner))).then((lists) => lists.flat())
    : Promise.resolve([]);
  await Promise.all(
    viewer.years.contributionYears
      .filter((year) => year < currentYear)
      .map(async (year) => {
        years[year] = (valid && cache.years[year]) || sumYear(await fetchYear(gql, year), keep);
      }),
  );

  const listed = new Set(Object.values(years).flatMap((y) => y.repos));
  const names = new Set([...listed, ...owned.filter(keep).map((r) => r.nameWithOwner)]);
  // Private repos already listed by contributionsCollection have their commits counted there.
  const hidden = (await privatePromise).filter((r) => keep(r) && !listed.has(r.nameWithOwner)).map((r) => r.nameWithOwner);
  const [repos, privateCommits, avatar] = await Promise.all([
    fetchRepoDetails(gql, [...names]),
    countCommits(gql, viewer.id, hidden),
    avatarPromise,
  ]);

  const skipLanguage = new Set(config.excludeLanguages.map((l) => l.toLowerCase()));
  const bytes = new Map<string, number>();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      if (!skipLanguage.has(node.name.toLowerCase())) bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
    }
  }
  const totalBytes = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const activeDays = Object.values(years).flatMap((y) => y.activeDays);
  const total = (field: keyof Omit<YearTotals, "repos" | "activeDays">) => Object.values(years).reduce((sum, y) => sum + y[field], 0);

  const stats: GitHubStats = {
    login: viewer.login,
    name: viewer.name ?? viewer.login,
    avatar,
    contributions: total("commits") + total("pullRequests") + total("issues") + total("reviews") + total("created") + total("restricted"),
    commits: total("commits") + privateCommits,
    pullRequests: pullRequests.filter((pr) => keep(pr.repository)).length,
    issues: total("issues"),
    reviews: total("reviews"),
    stars: repos.reduce((sum, r) => sum + r.stargazerCount, 0),
    forks: repos.reduce((sum, r) => sum + r.forkCount, 0),
    repos: repos.length,
    activeDays: activeDays.length,
    longestStreak: longestStreak(activeDays),
    languages: [...bytes.entries()].sort((a, b) => b[1] - a[1]).map(([name, size]) => [name, (size / totalBytes) * 100]),
  };
  const finished = Object.fromEntries(Object.entries(years).filter(([year]) => Number(year) < currentYear));
  return {
    stats,
    cache: { key, savedAt: valid ? cache.savedAt : new Date().toISOString(), years: finished },
  };
}
