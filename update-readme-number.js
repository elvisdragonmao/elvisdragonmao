#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START_MARKER = "<!-- readme-profile-stats:start -->";
const END_MARKER = "<!-- readme-profile-stats:end -->";
const TOP_LAYER_START_MARKER = "<!-- readme-profile-top-layer:start -->";
const TOP_LAYER_END_MARKER = "<!-- readme-profile-top-layer:end -->";
const LEGACY_START_MARKER = "<!-- readme-top-right-number:start -->";
const LEGACY_END_MARKER = "<!-- readme-top-right-number:end -->";
const DEFAULT_TIME_ZONE = "Asia/Taipei";

const STAT_CARDS = [
  {
    key: "commits",
    label: "Commits",
    api: "commits",
    gradient: "paint5_linear_28_350",
    color: "#0CB39B",
    x: 1181,
    y: 158,
    textX: 1186,
    textY: 195,
  },
  {
    key: "stars",
    label: "Stars",
    api: "stars",
    gradient: "paint7_linear_28_350",
    color: "#F8C568",
    x: 1392,
    y: 158,
    textX: 1398,
    textY: 195,
  },
  {
    key: "prs",
    label: "PR opened",
    api: "pullRequests",
    gradient: "paint6_linear_28_350",
    color: "#8B51F3",
    x: 1181,
    y: 307,
    textX: 1186,
    textY: 344,
  },
  {
    key: "issues",
    label: "Issues opened",
    api: "issues",
    gradient: "paint8_linear_28_350",
    color: "#F36067",
    x: 1392,
    y: 307,
    textX: 1398,
    textY: 344,
  },
  {
    key: "reviews",
    label: "PR reviewed",
    api: "reviews",
    gradient: "paint9_linear_28_350",
    color: "#2498FA",
    x: 1392,
    y: 456,
    textX: 1398,
    textY: 493,
  },
];

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const svgPath = resolve(repoRoot, args.svg ?? "profile.svg");
const bubbleTeaPath = resolve(repoRoot, args["bubble-tea"] ?? "bubble-tea.svg");
const username = args.username ?? process.env.GITHUB_USERNAME ?? "elvisdragonmao";
const token = getGitHubToken(args);
const updatedAt = args.date ?? args["updated-at"] ?? getCurrentDate(DEFAULT_TIME_ZONE);
const values = await resolveStatValues({ args, username, token });
const bubbleTeaIcon = extractSvgBody(await readFile(bubbleTeaPath, "utf8"));

const svg = await readFile(svgPath, "utf8");
const withStats = upsertStatsOverlay(removeLegacyOverlay(normalizeHeroImageLayer(svg)), {
  values,
  username,
});
const nextSvg = upsertTopLayerOverlay(withStats, {
  bubbleTeaIcon,
  updatedAt,
});

if (args["dry-run"]) {
  console.log(JSON.stringify({ ...values, updatedAt }, null, 2));
} else {
  await writeFile(svgPath, nextSvg);
  const summary = STAT_CARDS.map((card) => `${card.key}=${values[card.key]}`).join(", ");
  console.log(`Updated ${svgPath}: ${summary}, updatedAt=${updatedAt}.`);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const nextValue = argv[index + 1];

    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (nextValue && !nextValue.startsWith("--")) {
      parsed[key] = nextValue;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }

  return parsed;
}

function getGitHubToken(args) {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }

  if (args["no-gh-token"]) {
    return undefined;
  }

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

async function resolveStatValues({ args, username, token }) {
  const values = {};
  const manualValues = parseManualValues(args);
  const missingCards = [];

  for (const card of STAT_CARDS) {
    if (manualValues[card.key] !== undefined) {
      values[card.key] = normalizeDisplayValue(manualValues[card.key]);
    } else {
      missingCards.push(card);
    }
  }

  if (missingCards.length > 0) {
    const apiValues = await fetchGitHubStats({ username, token });

    for (const card of missingCards) {
      values[card.key] = formatNumber(apiValues[card.api]);
    }
  }

  return values;
}

function parseManualValues(args) {
  const values = {};

  if (args.values) {
    for (const pair of String(args.values).split(",")) {
      const [rawKey, rawValue] = pair.split("=", 2);
      const key = normalizeStatKey(rawKey);

      if (key && rawValue !== undefined) {
        values[key] = rawValue;
      }
    }
  }

  for (const card of STAT_CARDS) {
    if (args[card.key] !== undefined) {
      values[card.key] = args[card.key];
    }
  }

  if (args.pullRequests !== undefined) {
    values.prs = args.pullRequests;
  }

  if (args.pull_requests !== undefined) {
    values.prs = args.pull_requests;
  }

  if (args["pull-requests"] !== undefined) {
    values.prs = args["pull-requests"];
  }

  if (args.value !== undefined) {
    values[normalizeStatKey(args.source) ?? "stars"] = args.value;
  }

  return values;
}

function normalizeStatKey(value) {
  if (!value) {
    return undefined;
  }

  const key = String(value).trim().toLowerCase();
  const aliases = {
    commit: "commits",
    commits: "commits",
    star: "stars",
    stars: "stars",
    pr: "prs",
    prs: "prs",
    pullrequest: "prs",
    pullrequests: "prs",
    "pull-request": "prs",
    "pull-requests": "prs",
    issue: "issues",
    issues: "issues",
    review: "reviews",
    reviews: "reviews",
    reviewed: "reviews",
  };

  return aliases[key];
}

async function fetchGitHubStats({ username, token }) {
  const [stars, commits, pullRequests, issues, reviews] = await Promise.all([
    fetchTotalStars({ username, token }),
    fetchSearchCount({
      token,
      path: "/search/commits",
      query: `author:${username} is:public`,
    }),
    fetchSearchCount({
      token,
      path: "/search/issues",
      query: `type:pr author:${username} is:public`,
    }),
    fetchSearchCount({
      token,
      path: "/search/issues",
      query: `type:issue author:${username} is:public`,
    }),
    fetchSearchCount({
      token,
      path: "/search/issues",
      query: `type:pr reviewed-by:${username} is:public`,
    }),
  ]);

  return {
    stars,
    commits,
    pullRequests,
    issues,
    reviews,
  };
}

async function fetchTotalStars({ username, token }) {
  let page = 1;
  let total = 0;

  while (true) {
    const repos = await githubFetch({
      token,
      url: `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}`,
    });

    total += repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);

    if (repos.length < 100) {
      return total;
    }

    page += 1;
  }
}

async function fetchSearchCount({ path, query, token }) {
  const params = new URLSearchParams({
    q: query,
    per_page: "1",
  });

  const data = await githubFetch({
    token,
    url: `https://api.github.com${path}?${params.toString()}`,
  });

  return data.total_count;
}

async function githubFetch({ url, token }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "readme-number-updater",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}\n${message}`);
  }

  return response.json();
}

function normalizeDisplayValue(value) {
  const displayValue = String(value).trim();

  if (!/^\d+(?:\.\d+)?[km]?$/i.test(displayValue)) {
    throw new Error(`Invalid display value: ${value}`);
  }

  return displayValue.toLowerCase();
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number: ${value}`);
  }

  if (value < 1000) {
    return String(value);
  }

  if (value < 1_000_000) {
    return `${trimTrailingZero(value / 1000)}k`;
  }

  return `${trimTrailingZero(value / 1_000_000)}m`;
}

function trimTrailingZero(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function getCurrentDate(timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date());
  const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

function upsertStatsOverlay(svg, { values, username }) {
  const overlay = [
    START_MARKER,
    `<g id="readme-profile-stats" data-username="${escapeXml(username)}">`,
    ...STAT_CARDS.flatMap((card) => renderStatCardOverlay(card, values[card.key])),
    "</g>",
    END_MARKER,
  ].join("\n");

  const markerPattern = new RegExp(`${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}`);

  if (markerPattern.test(svg)) {
    return svg.replace(markerPattern, overlay);
  }

  const defsIndex = svg.indexOf("<defs>");

  if (defsIndex === -1) {
    return svg.replace("</svg>", `${overlay}\n</svg>`);
  }

  return `${svg.slice(0, defsIndex)}${overlay}\n${svg.slice(defsIndex)}`;
}

function upsertTopLayerOverlay(svg, { bubbleTeaIcon, updatedAt }) {
  const overlay = [
    TOP_LAYER_START_MARKER,
    '<g id="readme-profile-top-layer">',
    `  <text id="readme-profile-updated-at" x="1538" y="621" fill="#596273" opacity="0.34" font-family="Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="18" font-weight="500" text-anchor="end">Updated ${escapeXml(updatedAt)}</text>`,
    '  <g id="readme-profile-bubble-tea" transform="translate(480 686) scale(0.8)">',
    indentSvg(bubbleTeaIcon, 4),
    "  </g>",
    "</g>",
    TOP_LAYER_END_MARKER,
  ].join("\n");

  const markerPattern = new RegExp(
    `${escapeRegExp(TOP_LAYER_START_MARKER)}[\\s\\S]*?${escapeRegExp(TOP_LAYER_END_MARKER)}`,
  );

  if (markerPattern.test(svg)) {
    return svg.replace(markerPattern, overlay);
  }

  const defsIndex = svg.indexOf("<defs>");

  if (defsIndex === -1) {
    return svg.replace("</svg>", `${overlay}\n</svg>`);
  }

  return `${svg.slice(0, defsIndex)}${overlay}\n${svg.slice(defsIndex)}`;
}

function renderStatCardOverlay(card, value) {
  const escapedValue = escapeXml(value);

  return [
    `  <g id="readme-profile-stat-${card.key}" data-label="${escapeXml(card.label)}">`,
    `    <rect x="${card.x}" y="${card.y}" width="165" height="45" rx="6" fill="url(#${card.gradient})"/>`,
    `    <text id="readme-profile-stat-${card.key}-value" x="${card.textX}" y="${card.textY}" fill="${card.color}" font-family="Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="39" font-weight="700" letter-spacing="0">${escapedValue}</text>`,
    "  </g>",
  ];
}

function removeLegacyOverlay(svg) {
  const markerPattern = new RegExp(
    `${escapeRegExp(LEGACY_START_MARKER)}[\\s\\S]*?${escapeRegExp(LEGACY_END_MARKER)}\\n?`,
  );

  return svg.replace(markerPattern, "");
}

function extractSvgBody(svg) {
  const match = svg.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/);

  if (!match) {
    throw new Error("Invalid bubble tea SVG.");
  }

  return match[1].trim();
}

function indentSvg(svg, spaces) {
  const indentation = " ".repeat(spaces);
  return svg
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
}

function normalizeHeroImageLayer(svg) {
  const heroImage = '<rect x="393" width="1069" height="623" fill="url(#pattern0_28_350)"/>';
  const firstStatCard = '<rect x="1168" y="92" width="193" height="132" rx="15" fill="url(#paint5_linear_28_350)"/>';

  const heroIndex = svg.indexOf(heroImage);
  const cardIndex = svg.indexOf(firstStatCard);

  if (heroIndex === -1 || cardIndex === -1 || heroIndex < cardIndex) {
    return svg;
  }

  const withoutHero = svg.replace(`${heroImage}\n`, "");
  return withoutHero.replace(firstStatCard, `${heroImage}\n${firstStatCard}`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
