import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUrl, sectionPath, urlQualityIssues, registrableRoot } from '../src/core/url.js';
import { simhash, hammingDistanceHex, looksLikeQuestion, fleschReadingEase, stem } from '../src/core/text.js';
import { parseHtml, byTag, textContent, attr } from '../src/parser/dom.js';
import { tokenize, decodeEntities } from '../src/parser/tokenizer.js';
import { parsePage } from '../src/parser/page.js';
import { extractStructuredData } from '../src/parser/structured-data.js';
import { parseRobots, isAllowed } from '../src/crawler/robots.js';
import { parseSitemap } from '../src/crawler/sitemap.js';
import { buildGraph, bfsDepths, pageRank, orphans } from '../src/site-graph/graph.js';
import { unifiedDiff, setTitle, setCanonical, setMetaByName, addJsonLd } from '../src/implementation-engine/patch.js';
import { GraphStore } from '../src/core/store.js';
import { observed, inferred } from '../src/core/model.js';
import { problemKey } from '../src/core/ids.js';
import { priorityScore, corroboratedConfidence } from '../src/core/severity.js';

describe('URL normalization', () => {
  test('collapses equivalent URLs to one form', () => {
    const a = normalizeUrl('https://Example.com:443/a/b/?utm_source=x&b=2&a=1#frag');
    const b = normalizeUrl('https://example.com/a/b?a=1&b=2');
    assert.equal(a, b);
  });

  test('rejects non-http schemes', () => {
    assert.equal(normalizeUrl('mailto:a@b.com'), null);
    assert.equal(normalizeUrl('javascript:alert(1)'), null);
  });

  test('resolves relative URLs against a base', () => {
    assert.equal(normalizeUrl('../c', 'https://example.com/a/b/d'), 'https://example.com/a/c');
  });

  test('derives section patterns', () => {
    assert.equal(sectionPath('https://e.com/'), '/');
    assert.equal(sectionPath('https://e.com/about'), '/about');
    assert.equal(sectionPath('https://e.com/blog/2024/post'), '/blog/*');
  });

  test('flags hostile URL shapes', () => {
    const issues = urlQualityIssues('https://e.com/My_Page/a/b/c/d/e/f');
    assert.ok(issues.includes('uppercase-characters'));
    assert.ok(issues.includes('underscores'));
    assert.ok(issues.includes('excessive-depth'));
  });

  test('handles multi-level public suffixes', () => {
    assert.equal(registrableRoot('shop.example.co.uk'), 'example.co.uk');
    assert.equal(registrableRoot('example.com'), 'example.com');
  });
});

describe('text analysis', () => {
  test('simhash places near-duplicates close together', () => {
    const a = 'The quick brown fox jumps over the lazy dog in the meadow every single morning.';
    const b = 'The quick brown fox jumps over the lazy dog in the meadow every single evening.';
    const c = 'Structured data validation requires checking required properties against the vocabulary.';
    assert.ok(hammingDistanceHex(simhash(a), simhash(b)) < hammingDistanceHex(simhash(a), simhash(c)));
  });

  test('identifies questions', () => {
    assert.ok(looksLikeQuestion('What is a boundary survey?'));
    assert.ok(looksLikeQuestion('How long does it take'));
    assert.ok(!looksLikeQuestion('Boundary surveys explained'));
  });

  test('readability returns a finite score', () => {
    const score = fleschReadingEase('This is a short sentence. Here is another one.');
    assert.ok(Number.isFinite(score));
  });

  test('stemming groups word forms', () => {
    assert.equal(stem('surveying'), stem('survey'));
  });
});

describe('HTML tokenizer and DOM', () => {
  test('parses attributes in every quoting style', () => {
    const tokens = tokenize('<a href="x" data-a=\'y\' data-b=z disabled>');
    const tag = tokens.find((t) => t.kind === 'startTag');
    assert.ok(tag && tag.kind === 'startTag');
    assert.equal(tag.attrs.href, 'x');
    assert.equal(tag.attrs['data-a'], 'y');
    assert.equal(tag.attrs['data-b'], 'z');
    assert.equal(tag.attrs.disabled, '');
  });

  test('does not parse markup inside script content', () => {
    const doc = parseHtml('<body><script>var s = "<div>not real</div>";</script><p>real</p></body>');
    assert.equal(byTag(doc, 'div').length, 0);
    assert.equal(byTag(doc, 'p').length, 1);
  });

  test('applies implicit close rules for list items and paragraphs', () => {
    const doc = parseHtml('<ul><li>one<li>two</ul><p>a<p>b');
    assert.equal(byTag(doc, 'li').length, 2);
    assert.equal(byTag(doc, 'p').length, 2);
  });

  test('decodes entities including numeric references', () => {
    assert.equal(decodeEntities('a &amp; b &#65; &#x42; &nbsp;'), 'a & b A B  ');
  });

  test('textContent inserts block boundaries so words do not fuse', () => {
    const doc = parseHtml('<div><p>one</p><p>two</p></div>');
    assert.ok(textContent(doc).includes('one'));
    assert.ok(!textContent(doc).includes('onetwo'));
  });

  test('excludes hidden and script content from text', () => {
    const doc = parseHtml('<body><p>visible</p><p hidden>secret</p><style>.a{}</style></body>');
    const text = textContent(doc);
    assert.ok(text.includes('visible'));
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('.a{}'));
  });

  test('survives unclosed tags without losing content', () => {
    const doc = parseHtml('<div><p>hello<div><span>world</div>');
    assert.ok(textContent(doc).includes('hello'));
    assert.ok(textContent(doc).includes('world'));
  });
});

describe('page extraction', () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Test Page</title>
    <meta name="description" content="A description.">
    <link rel="canonical" href="/canonical-target">
    <meta property="og:title" content="OG Title">
    <meta name="robots" content="index, follow">
    <meta name="viewport" content="width=device-width">
    </head><body>
    <nav><a href="/nav-link">Nav</a></nav>
    <main><h1>Heading</h1><h2>Sub</h2><h4>Skipped</h4>
    <p>Some real content in the main region of this document that is long enough to be detected.</p>
    <a href="/content-link">Content link</a>
    <img src="/a.jpg" alt="alt text"><img src="/b.jpg">
    </main><footer><a href="https://external.example/x">External</a></footer></body></html>`;

  const parsed = parsePage(html, 'https://site.test/page');

  test('extracts head metadata', () => {
    assert.equal(parsed.title, 'Test Page');
    assert.equal(parsed.metaDescription, 'A description.');
    assert.equal(parsed.canonical, 'https://site.test/canonical-target');
    assert.equal(parsed.lang, 'en');
    assert.equal(parsed.openGraph['og:title'], 'OG Title');
    assert.deepEqual(parsed.robotsMeta, ['index', 'follow']);
    assert.equal(parsed.viewport, 'width=device-width');
  });

  test('records the heading outline including skipped levels', () => {
    assert.deepEqual(parsed.headings.map((h) => h.level), [1, 2, 4]);
  });

  test('separates internal from external links', () => {
    const internal = parsed.links.filter((l) => l.internal).map((l) => l.href);
    assert.ok(internal.includes('https://site.test/content-link'));
    assert.ok(parsed.links.some((l) => !l.internal));
  });

  test('marks links outside main content as boilerplate', () => {
    const nav = parsed.links.find((l) => l.href.endsWith('/nav-link'));
    const content = parsed.links.find((l) => l.href.endsWith('/content-link'));
    assert.equal(nav?.inMainContent, false);
    assert.equal(content?.inMainContent, true);
  });

  test('distinguishes a missing alt from an empty one', () => {
    const withAlt = parsed.images.find((i) => i.src.endsWith('/a.jpg'));
    const without = parsed.images.find((i) => i.src.endsWith('/b.jpg'));
    assert.equal(withAlt?.alt, 'alt text');
    assert.equal(without?.alt, null);
  });
});

describe('structured data', () => {
  test('flattens @graph and arrays', () => {
    const doc = parseHtml(`<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Organization","name":"A"},
        {"@type":"WebSite","name":"B"}]}</script>`);
    const blocks = extractStructuredData(doc);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((b) => b.types[0]).sort(), ['Organization', 'WebSite']);
  });

  test('records a parse error rather than throwing', () => {
    const doc = parseHtml('<script type="application/ld+json">{ not json }</script>');
    const blocks = extractStructuredData(doc);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].parseError);
  });

  test('extracts microdata', () => {
    const doc = parseHtml(`<div itemscope itemtype="https://schema.org/Person">
      <span itemprop="name">Ada</span><span itemprop="jobTitle">Engineer</span></div>`);
    const blocks = extractStructuredData(doc);
    assert.equal(blocks[0].types[0], 'Person');
    assert.equal((blocks[0].raw as Record<string, unknown>).name, 'Ada');
  });

  test('normalizes fully qualified schema types', () => {
    const doc = parseHtml('<script type="application/ld+json">{"@type":"https://schema.org/Article"}</script>');
    assert.equal(extractStructuredData(doc)[0].types[0], 'Article');
  });
});

describe('robots.txt', () => {
  const robots = parseRobots(
    `User-agent: *
Disallow: /private/
Allow: /private/public-page
Crawl-delay: 2

User-agent: BadBot
Disallow: /

Sitemap: https://e.com/sitemap.xml`,
    'https://e.com/robots.txt', 200,
  );

  test('parses groups and sitemap references', () => {
    assert.equal(robots.groups.length, 2);
    assert.deepEqual(robots.sitemaps, ['https://e.com/sitemap.xml']);
  });

  test('applies longest-match with Allow winning ties', () => {
    assert.equal(isAllowed(robots, 'UWOE', 'https://e.com/private/secret').allowed, false);
    assert.equal(isAllowed(robots, 'UWOE', 'https://e.com/private/public-page').allowed, true);
    assert.equal(isAllowed(robots, 'UWOE', 'https://e.com/open').allowed, true);
  });

  test('selects the most specific user-agent group', () => {
    assert.equal(isAllowed(robots, 'BadBot/1.0', 'https://e.com/anything').allowed, false);
  });

  test('honours wildcards and end anchors', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$', 'https://e.com/robots.txt', 200);
    assert.equal(isAllowed(r, 'UWOE', 'https://e.com/a/b.pdf').allowed, false);
    assert.equal(isAllowed(r, 'UWOE', 'https://e.com/a/b.pdf.html').allowed, true);
  });

  test('an empty Disallow allows everything', () => {
    const r = parseRobots('User-agent: *\nDisallow:', 'https://e.com/robots.txt', 200);
    assert.equal(isAllowed(r, 'UWOE', 'https://e.com/anything').allowed, true);
  });
});

describe('sitemaps', () => {
  test('parses a urlset', () => {
    const doc = parseSitemap(
      `<?xml version="1.0"?><urlset><url><loc>https://e.com/a</loc><lastmod>2024-01-01</lastmod></url>
       <url><loc>https://e.com/b</loc></url></urlset>`, 'https://e.com/sitemap.xml');
    assert.equal(doc.kind, 'urlset');
    assert.equal(doc.entries.length, 2);
    assert.equal(doc.entries[0].lastmod, '2024-01-01');
  });

  test('parses a sitemap index', () => {
    const doc = parseSitemap(
      '<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>',
      'https://e.com/sitemap.xml');
    assert.equal(doc.kind, 'sitemapindex');
    assert.deepEqual(doc.children, ['https://e.com/s1.xml']);
  });

  test('accepts a plain-text sitemap', () => {
    const doc = parseSitemap('https://e.com/a\nhttps://e.com/b\n', 'https://e.com/sitemap.txt');
    assert.equal(doc.entries.length, 2);
  });
});

describe('graph algorithms', () => {
  const g = buildGraph(['a', 'b', 'c', 'd', 'x'], [['a', 'b'], ['b', 'c'], ['a', 'c'], ['c', 'd']]);

  test('bfs computes shortest depth from the source', () => {
    const depths = bfsDepths(g, ['a']);
    assert.equal(depths.get('a'), 0);
    assert.equal(depths.get('b'), 1);
    assert.equal(depths.get('c'), 1);
    assert.equal(depths.get('d'), 2);
    assert.equal(depths.get('x'), Infinity);
  });

  test('pagerank sums to one and ranks linked pages above unlinked', () => {
    const ranks = pageRank(g);
    const total = [...ranks.values()].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 0.01);
    assert.ok(ranks.get('c')! > ranks.get('x')!);
  });

  test('finds nodes with no inbound edges', () => {
    assert.deepEqual(orphans(g).sort(), ['a', 'x']);
  });
});

describe('patch generation', () => {
  test('produces a unified diff with context', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after = 'one\ntwo\nCHANGED\nfour\nfive\n';
    const diff = unifiedDiff(before, after, 'f.txt');
    assert.ok(diff.includes('--- a/f.txt'));
    assert.ok(diff.includes('-three'));
    assert.ok(diff.includes('+CHANGED'));
    assert.ok(diff.includes(' two'));
  });

  test('returns an empty diff when nothing changed', () => {
    assert.equal(unifiedDiff('same\n', 'same\n', 'f.txt'), '');
  });

  test('rewrites an existing title in place', () => {
    const r = setTitle('<html><head><title>Old</title></head></html>', 'New');
    assert.ok(r.changed);
    assert.ok(r.html.includes('<title>New</title>'));
    assert.ok(!r.html.includes('Old'));
  });

  test('inserts a title when none exists', () => {
    const r = setTitle('<html>\n<head>\n  <meta charset="utf-8">\n</head>\n</html>', 'Added');
    assert.ok(r.changed);
    assert.ok(r.html.includes('<title>Added</title>'));
    assert.ok(r.html.indexOf('<title>') < r.html.indexOf('</head>'));
  });

  test('reports no change when the value already matches', () => {
    const r = setTitle('<head><title>Same</title></head>', 'Same');
    assert.equal(r.changed, false);
  });

  test('escapes values written into attributes', () => {
    const r = setMetaByName('<head></head>', 'description', 'He said "hi" & left');
    assert.ok(r.html.includes('&quot;'));
    assert.ok(r.html.includes('&amp;'));
  });

  test('updates an existing canonical rather than adding a second', () => {
    const r = setCanonical('<head><link rel="canonical" href="/old"></head>', '/new');
    assert.ok(r.changed);
    assert.equal((r.html.match(/rel="canonical"/g) ?? []).length, 1);
    assert.ok(r.html.includes('/new'));
  });

  test('refuses to inject JSON that would break out of the script block', () => {
    const r = addJsonLd('<head></head>', { name: '</script><script>alert(1)</script>' });
    assert.equal(r.changed, false);
    assert.ok(r.reason?.includes('closing script tag'));
  });
});

describe('graph store', () => {
  test('upserts nodes by identity, not by content', () => {
    const store = new GraphStore(':memory:');
    const a = store.upsertNode('Page', 'https://e.com/a', 'A', { url: 'https://e.com/a', v: 1 });
    const b = store.upsertNode('Page', 'https://e.com/a', 'A2', { v: 2 });
    assert.equal(a.id, b.id);
    assert.equal((store.getNode(a.id)!.props as { v: number }).v, 2);
    assert.equal(store.nodesOfType('Page').length, 1);
    store.close();
  });

  test('rejects edges with no evidence', () => {
    const store = new GraphStore(':memory:');
    const a = store.upsertNode('Page', 'a', 'A', {});
    const b = store.upsertNode('Page', 'b', 'B', {});
    assert.equal(store.addEdge('links_to', a.id, b.id, []), null);
    assert.ok(store.addEdge('links_to', a.id, b.id, [observed('test', 'a')]));
    assert.equal(store.outgoing(a.id, 'links_to').length, 1);
    assert.equal(store.incoming(b.id, 'links_to').length, 1);
    store.close();
  });

  test('round-trips records', () => {
    const store = new GraphStore(':memory:');
    store.putRecord('thing', 'id1', { a: 1 });
    assert.deepEqual(store.getRecord('thing', 'id1'), { a: 1 });
    assert.equal(store.listRecords('thing').length, 1);
    store.close();
  });
});

describe('problem keys and scoring', () => {
  test('the same family and scope produce the same key across engines', () => {
    assert.equal(problemKey('TITLE_MISSING', 'https://e.com/a'), problemKey('TITLE_MISSING', 'https://e.com/a'));
    assert.notEqual(problemKey('TITLE_MISSING', 'https://e.com/a'), problemKey('TITLE_MISSING', 'https://e.com/b'));
  });

  test('corroboration raises confidence above any single detector', () => {
    const single = corroboratedConfidence([0.6]);
    const triple = corroboratedConfidence([0.6, 0.6, 0.6]);
    assert.ok(triple > single);
    assert.ok(triple < 1);
  });

  test('priority rises with reach and falls when blocked', () => {
    const base = {
      severity: 'high' as const, confidence: 0.9, category: 'TECHNICAL_SEO' as const,
      totalPageCount: 100, unblocks: 0, blocked: false,
    };
    assert.ok(priorityScore({ ...base, affectedUrlCount: 50 }) > priorityScore({ ...base, affectedUrlCount: 1 }));
    assert.ok(priorityScore({ ...base, affectedUrlCount: 50, blocked: true }) < priorityScore({ ...base, affectedUrlCount: 50 }));
  });
});

describe('evidence discipline', () => {
  test('evidence records its kind so observation is never confused with inference', () => {
    const o = observed('parser.head', 'https://e.com/a', { excerpt: '<title>x</title>' });
    const i = inferred('geo', 'https://e.com/a', { note: 'reads as shallow coverage' });
    assert.equal(o.kind, 'observed');
    assert.equal(i.kind, 'inferred');
    assert.ok(o.excerpt);
  });
});
