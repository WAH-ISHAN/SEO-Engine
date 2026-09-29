/**
 * robots.txt parsing and matching, following the Robots Exclusion Protocol
 * (RFC 9309): longest-match wins, Allow beats Disallow on equal length, and
 * wildcards `*` and `$` are honoured.
 */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
  /** Precompiled matcher for the path pattern. */
  re: RegExp;
  /** Specificity used for longest-match resolution. */
  length: number;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay: number | null;
}

export interface RobotsTxt {
  url: string;
  fetched: boolean;
  status: number | null;
  groups: RobotsGroup[];
  sitemaps: string[];
  raw: string;
  /** Lines the parser did not understand, kept as evidence of config drift. */
  unknownDirectives: string[];
}

export const PERMISSIVE_ROBOTS: RobotsTxt = {
  url: '', fetched: false, status: null, groups: [], sitemaps: [], raw: '', unknownDirectives: [],
};

export function parseRobots(raw: string, url: string, status: number | null): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const unknownDirectives: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      unknownDirectives.push(rawLine.trim());
      continue;
    }
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [], crawlDelay: null };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        break;
      }
      case 'allow':
      case 'disallow': {
        lastWasAgent = false;
        if (!current) {
          current = { agents: ['*'], rules: [], crawlDelay: null };
          groups.push(current);
        }
        // An empty Disallow means "allow everything" and carries no rule.
        if (field === 'disallow' && value === '') break;
        current.rules.push(makeRule(field, value));
        break;
      }
      case 'crawl-delay': {
        lastWasAgent = false;
        const n = Number.parseFloat(value);
        if (current && Number.isFinite(n)) current.crawlDelay = n;
        break;
      }
      case 'sitemap': {
        lastWasAgent = false;
        if (value) sitemaps.push(value);
        break;
      }
      default:
        lastWasAgent = false;
        unknownDirectives.push(line);
    }
  }
  return { url, fetched: true, status, groups, sitemaps, raw, unknownDirectives };
}

function makeRule(type: 'allow' | 'disallow', pattern: string): RobotsRule {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const anchored = escaped.endsWith('\\$') ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  let re: RegExp;
  try {
    re = new RegExp(anchored);
  } catch {
    re = /^$/;
  }
  return { type, path: pattern, re, length: pattern.replace(/\$$/, '').length };
}

/** Picks the most specific matching group: exact agent beats `*`. */
export function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLen = -1;
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a === '*') {
        if (bestLen < 0) {
          best = g;
          bestLen = 0;
        }
      } else if (ua.includes(a) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  return best;
}

export interface RobotsDecision {
  allowed: boolean;
  /** The matching rule, for evidence. */
  rule: string | null;
  crawlDelay: number | null;
}

export function isAllowed(robots: RobotsTxt, userAgent: string, url: string): RobotsDecision {
  if (!robots.fetched) return { allowed: true, rule: null, crawlDelay: null };
  const group = groupFor(robots, userAgent);
  if (!group) return { allowed: true, rule: null, crawlDelay: null };

  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return { allowed: true, rule: null, crawlDelay: group.crawlDelay };
  }

  let winner: RobotsRule | null = null;
  for (const r of group.rules) {
    if (!r.re.test(path)) continue;
    if (
      !winner ||
      r.length > winner.length ||
      (r.length === winner.length && r.type === 'allow' && winner.type === 'disallow')
    ) {
      winner = r;
    }
  }
  return {
    allowed: !winner || winner.type === 'allow',
    rule: winner ? `${winner.type === 'allow' ? 'Allow' : 'Disallow'}: ${winner.path}` : null,
    crawlDelay: group.crawlDelay,
  };
}
