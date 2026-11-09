import type { Config } from "./config.ts";
import type { GitHubStats } from "./github.ts";
import type { AiStats, Day } from "./tokenmaxxing.ts";

export interface Theme {
  ink: string;
  muted: string;
  line: string;
  seed: string;
  heat: string[];
}

interface Slice {
  name: string;
  share: number;
  color: string;
}

interface Section {
  height: number;
  body: string;
}

// The background stays transparent so it sits on GitHub's own page color in both themes.
export const THEMES: Record<"light" | "dark", Theme> = {
  light: { ink: "#2B2A26", muted: "#7A776E", line: "#E7E3D9", seed: "#E6E2D7", heat: ["#F4D3D9", "#EEB3BE", "#E8919F", "#DD6F86"] },
  dark: { ink: "#EDEBE4", muted: "#9AA19A", line: "#262C27", seed: "#262C27", heat: ["#4A2A33", "#7A3E4E", "#B85A70", "#E8919F"] },
};
const PALETTE = {
  rose: "#E8919F",
  sky: "#8DB8DD",
  butter: "#F1C75F",
  lilac: "#AE9BDB",
  coral: "#EE9C7F",
  sage: "#9CC08F",
  blush: "#E3AFCB",
};
const LANG_COLORS = [PALETTE.rose, PALETTE.sky, PALETTE.butter, PALETTE.lilac, PALETTE.coral, PALETTE.sage, PALETTE.blush];
const MODEL_COLORS = [PALETTE.coral, PALETTE.rose, PALETTE.sage, PALETTE.sky, PALETTE.lilac];

const SERIF = `"Iowan Old Style","Palatino Linotype",Palatino,Georgia,ui-serif,serif`;
const SANS = `ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace`;

const W = 840;
const X0 = 20;
const X1 = W - 20;
const SECTION_GAP = 44;
const MS_DAY = 86_400_000;

const r2 = (n: number) => Math.round(n * 100) / 100;
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : int(n);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Starts late and slow enough to still be visible after the GitHub page has settled.
const delay = (ms: number) => `animation-delay:${Math.round(500 + ms * 1.4)}ms`;
const toDate = (key: string) => new Date(`${key}T00:00:00Z`).getTime();
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dateLabel = (ms: number, options: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleString("en-US", { ...options, timeZone: "UTC" }).toLowerCase();

function eyebrow(x: number, y: number, label: string, ms: number): string {
  return `<text x="${x}" y="${y}" class="eyebrow up" style="${delay(ms)}">${esc(label.toUpperCase())}</text>`;
}

function stat(x: number, y: number, value: string, label: string, size: number, ms: number): string {
  return `<g class="up" style="${delay(ms)}"><text x="${x}" y="${y}" class="serif" font-size="${size}">${esc(value)}</text><text x="${x}" y="${y + 20}">${esc(label)}</text></g>`;
}

function divider(y: number, t: Theme, ms: number): string {
  return `<line x1="${X0}" y1="${y + 0.5}" x2="${X1}" y2="${y + 0.5}" stroke="${t.line}" class="up" style="${delay(ms)}"/>`;
}

function stackedBar(id: string, x: number, y: number, width: number, slices: Slice[], ms: number): string {
  let cursor = x;
  const segments = slices
    .filter(({ share }) => share > 0)
    .map(({ share, color }) => {
      const w = width * share;
      const rect = `<rect x="${r2(cursor)}" y="${y}" width="${r2(Math.max(w - 2, 1))}" height="6" fill="${color}"/>`;
      cursor += w;
      return rect;
    })
    .join("");
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${width}" height="6" rx="3"/></clipPath>
<g clip-path="url(#${id})"><g class="grow" style="transform-origin:${x}px 0;${delay(ms)}">${segments}</g></g>`;
}

// Two-column (or wider) legend with the name on the left and the share right-aligned.
function legend(slices: Slice[], x: number, y: number, width: number, columns: number, ms: number): string {
  const rows = Math.ceil(slices.length / columns);
  const colW = width / columns;
  return slices
    .map(({ name, share, color }, i) => {
      const col = Math.floor(i / rows);
      const left = x + col * colW + (col > 0 ? 14 : 0);
      const right = x + (col + 1) * colW - (col < columns - 1 ? 14 : 0);
      const ly = y + (i % rows) * 26;
      return `<g class="up" style="${delay(ms + i * 50)}"><circle cx="${r2(left + 4)}" cy="${ly - 4}" r="4" fill="${color}"/><text x="${r2(left + 16)}" y="${ly}" class="ink" font-size="13">${esc(name)}</text><text x="${r2(right)}" y="${ly}" class="mono" text-anchor="end">${(share * 100).toFixed(1)}%</text></g>`;
    })
    .join("\n");
}

function withOther(top: Slice[], t: Theme): Slice[] {
  const rest = Math.max(0, 1 - top.reduce((sum, s) => sum + s.share, 0));
  return rest > 0.0005 ? [...top, { name: "Other", share: rest, color: t.muted }] : top;
}

// Supports **bold** so a project name can stand out in the bio.
function bioLine(line: string): string {
  return esc(line).replace(/\*\*(.+?)\*\*/g, `<tspan class="ink" font-weight="600">$1</tspan>`);
}

function intro(config: Config, github: GitHubStats, t: Theme): Section {
  const name = config.name || github.name;
  const lines = config.bio
    .map((line, i) => `<text x="${X0}" y="${124 + i * 24}" class="up" font-size="15" style="${delay(200 + i * 80)}">${bioLine(line)}</text>`)
    .join("\n");
  const r = 60;
  const cx = X1 - r;
  const cy = 100;
  // GitHub's image proxy blocks external URLs inside SVGs, so the avatar is inlined.
  const avatar = github.avatar
    ? `<clipPath id="avatar"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
<g class="up" style="${delay(150)}"><image href="data:${github.avatar.mime};base64,${github.avatar.data}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#avatar)"/>
<circle cx="${cx}" cy="${cy}" r="${r - 0.5}" fill="none" stroke="${t.line}"/></g>`
    : "";
  return {
    height: Math.max(200, 124 + config.bio.length * 24 + 28),
    body: `
<text x="${X0 - 2}" y="84" class="serif up" font-size="52" style="${delay(80)}">${esc(config.greeting)} <tspan fill="${PALETTE.rose}" font-style="italic">${esc(name)}</tspan></text>
${lines}
${avatar}`,
  };
}

function githubSection(config: Config, github: GitHubStats, t: Theme, y: number, ms: number): Section {
  const stats: [string, string][] = [
    [int(github.contributions), "contributions"],
    [int(github.commits), "commits"],
    [int(github.pullRequests), "pull requests"],
    [int(github.stars), "stars earned"],
    [int(github.activeDays), "active days"],
    [`${github.longestStreak}d`, "longest streak"],
  ];
  const grid = stats
    .map(([value, label], i) => stat(X0 + (i % 3) * 112, y + 52 + Math.floor(i / 3) * 64, value, label, 28, ms + 60 + i * 60))
    .join("\n");
  const lx = 440;
  const slices = withOther(
    github.languages.slice(0, config.languages).map(([name, p], i) => ({ name, share: p / 100, color: LANG_COLORS[i] })),
    t,
  );
  return {
    height: 172,
    body: `
${eyebrow(X0, y, "GitHub", ms)}
${grid}
${eyebrow(lx, y, "Languages", ms)}
${stackedBar("langs", lx, y + 20, X1 - lx, slices, ms + 130)}
${legend(slices, lx, y + 52, X1 - lx, 2, ms + 180)}`,
  };
}

function modelShares(days: Day[], count: number, t: Theme): Slice[] {
  const tokens = new Map<string, number>();
  for (const d of days) tokens.set(d.key, (tokens.get(d.key) ?? 0) + d.totalTokens);
  const total = [...tokens.values()].reduce((a, b) => a + b, 0) || 1;
  const top = [...tokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, n], i) => ({ name, share: n / total, color: MODEL_COLORS[i] }));
  return withOther(top, t);
}

function aiSection(config: Config, ai: AiStats, t: Theme, y: number, ms: number): Section {
  const since = dateLabel(toDate(ai.firstDate), { month: "long", year: "numeric" });
  const slices = modelShares(ai.days, config.models, t);
  const sx = X1 - 392;
  return {
    height: 200,
    body: `
${eyebrow(X0, y, "AI usage", ms)}
<text x="${X1}" y="${y}" text-anchor="end" font-size="10" class="up" style="${delay(ms)}">via tokenmaxxing</text>
<text x="${X0 - 3}" y="${y + 70}" class="serif up" font-size="64" style="${delay(ms + 40)}">${compact(ai.totalTokens)}</text>
<text x="${X0}" y="${y + 100}" class="up" font-size="14" style="${delay(ms + 100)}">tokens across ${int(ai.sessionCount)} sessions since ${esc(since)}</text>
${stat(sx, y + 52, `$${int(ai.spendUsd)}`, "spent", 26, ms + 120)}
${stat(sx + 104, y + 52, int(ai.activeDays), "active days", 26, ms + 160)}
${stat(sx + 208, y + 52, `${ai.longestStreakDays}d`, "longest streak", 26, ms + 200)}
${stat(sx + 312, y + 52, ai.leaderboardRank ? `#${ai.leaderboardRank}` : "–", "leaderboard", 26, ms + 240)}
${stackedBar("models", X0, y + 120, X1 - X0, slices, ms + 180)}
${legend(slices, X0, y + 152, X1 - X0, 3, ms + 180)}`,
  };
}

function busiestWeekday(perDay: Map<string, number>): string {
  const totals = Array<number>(7).fill(0);
  for (const [date, tokens] of perDay) totals[new Date(toDate(date)).getUTCDay()] += tokens;
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][totals.indexOf(Math.max(...totals))];
}

function activitySection(ai: AiStats, t: Theme, y: number, ms: number): Section {
  const perDay = new Map<string, number>();
  for (const d of ai.days) perDay.set(d.date, (perDay.get(d.date) ?? 0) + d.totalTokens);
  const weekOf = (time: number) => time - ((new Date(time).getUTCDay() + 6) % 7) * MS_DAY;
  const thisWeek = weekOf(toDate(keyOf(Date.now())));
  const start = Math.max(weekOf(toDate(ai.firstDate)), thisWeek - 51 * 7 * MS_DAY);
  const weeks = Math.round((thisWeek - start) / (7 * MS_DAY)) + 1;
  const sorted = [...perDay.values()].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
  const thresholds = [q(0.25), q(0.5), q(0.75)];

  const sx = X1 - 196;
  const gx = X0 + 40;
  const gy = y + 38;
  // Columns stretch to fill the space up to the stats; rows keep a fixed pitch.
  const colStep = Math.min(24, (sx - 56 - gx) / Math.max(weeks - 1, 1));
  const rowStep = 16;
  const cells: string[] = [];
  const months: string[] = [];
  let lastMonth = -1;
  for (let time = start, i = 0; time <= Date.now(); time += MS_DAY, i++) {
    const col = Math.floor(i / 7);
    const row = i % 7;
    const date = new Date(time);
    if (row === 0 && date.getUTCMonth() !== lastMonth && date.getUTCDate() <= 7) {
      lastMonth = date.getUTCMonth();
      months.push(`<text x="${r2(gx + col * colStep - 6)}" y="${gy - 14}" font-size="11">${dateLabel(time, { month: "short" })}</text>`);
    }
    const tokens = perDay.get(keyOf(time)) ?? 0;
    const cx = r2(gx + col * colStep);
    const cy = gy + row * rowStep;
    const anim = `class="pop" style="transform-origin:${cx}px ${cy}px;${delay(ms + 60 + col * 28 + row * 12)}"`;
    cells.push(
      tokens === 0
        ? `<circle cx="${cx}" cy="${cy}" r="2" fill="${t.seed}" ${anim}/>`
        : `<circle cx="${cx}" cy="${cy}" r="6" fill="${t.heat[thresholds.filter((th) => tokens > th).length]}" ${anim}/>`,
    );
  }
  const [peakDate, peakTokens] = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const total = [...perDay.values()].reduce((a, b) => a + b, 0);
  const dayLabels = ["mon", "wed", "fri"]
    .map((d, i) => `<text x="${X0}" y="${gy + i * 2 * rowStep + 4}" font-size="11">${d}</text>`)
    .join("");
  const peakLabel = peakDate ? `peak day, ${dateLabel(toDate(peakDate), { month: "short", day: "numeric" })}` : "peak day";
  return {
    height: 176,
    body: `
${eyebrow(X0, y, "Daily tokens", ms)}
<g class="up" style="${delay(ms + 40)}">${months.join("")}${dayLabels}</g>
${cells.join("\n")}
${stat(sx, y + 46, compact(peakTokens), peakLabel, 24, ms + 260)}
${stat(sx, y + 104, compact(total / Math.max(perDay.size, 1)), "per active day", 24, ms + 340)}
${stat(sx + 96, y + 46, busiestWeekday(perDay), "busiest day", 24, ms + 420)}
${stat(sx + 96, y + 104, compact(q(0.5)), "median day", 24, ms + 500)}`,
  };
}

export function renderProfile(config: Config, github: GitHubStats, ai: AiStats | null, t: Theme): string {
  const head = intro(config, github, t);
  const sections: ((y: number, ms: number) => Section)[] = [(y, ms) => githubSection(config, github, t, y, ms)];
  if (ai) {
    sections.push((y, ms) => aiSection(config, ai, t, y, ms));
    sections.push((y, ms) => activitySection(ai, t, y, ms));
  }

  let body = head.body;
  let y = head.height;
  let ms = 300;
  for (const section of sections) {
    body += `\n${divider(y, t, ms)}`;
    const s = section(y + SECTION_GAP, ms + 20);
    body += s.body;
    y += SECTION_GAP + s.height;
    ms += 380;
  }
  const height = y - 24;
  const title = `${config.name || github.name}: GitHub${ai ? " and AI usage" : ""} stats`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
svg{font-size:12px}
text{font-family:${SANS};fill:${t.muted}}
.serif{font-family:${SERIF};fill:${t.ink}}
.ink{fill:${t.ink}}
.mono{font-family:${MONO}}
.eyebrow{font-size:11px;letter-spacing:1.4px;font-weight:600}
.up{animation:up 1.4s cubic-bezier(.2,.7,.2,1) both}
.pop{animation:pop .8s cubic-bezier(.3,1.6,.5,1) both}
.grow{animation:grow 1.8s cubic-bezier(.3,.8,.2,1) both}
@keyframes up{from{opacity:0;transform:translateY(8px)}}
@keyframes pop{from{transform:scale(0)}}
@keyframes grow{from{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
${body}
</svg>`;
}
