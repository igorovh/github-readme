export interface Day {
  date: string;
  key: string;
  totalTokens: number;
}

export interface AiStats {
  firstDate: string;
  totalTokens: number;
  spendUsd: number;
  sessionCount: number;
  activeDays: number;
  longestStreakDays: number;
  leaderboardRank: number | null;
  days: Day[];
}

const API = "https://api.tokenmaxxing.sh";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`tokenmaxxing returned ${res.status} for ${path}`);
  return res.json();
}

export async function fetchTokenmaxxing(login: string): Promise<AiStats> {
  const path = `/profiles/${encodeURIComponent(login)}`;
  const [profile, daily] = await Promise.all([
    get<{ stats: Omit<AiStats, "days"> }>(path),
    get<{ days: Day[] }>(`${path}/daily`),
  ]);
  const s = profile.stats;
  return {
    firstDate: s.firstDate,
    totalTokens: s.totalTokens,
    spendUsd: s.spendUsd,
    sessionCount: s.sessionCount,
    activeDays: s.activeDays,
    longestStreakDays: s.longestStreakDays,
    leaderboardRank: s.leaderboardRank,
    days: daily.days.map(({ date, key, totalTokens }) => ({ date, key, totalTokens })),
  };
}
