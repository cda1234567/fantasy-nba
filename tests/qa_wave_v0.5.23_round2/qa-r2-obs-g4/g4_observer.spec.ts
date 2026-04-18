import { test, expect, Page, Request, Response } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://nbafantasy.cda1234567.com';
const OUTPUT_DIR = __dirname;

// Utility: write JSON artifact
function writeArtifact(name: string, data: unknown) {
  const p = path.join(OUTPUT_DIR, `artifact_${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

test.describe('QA R2 G4 Observer — Performance Profiling', () => {
  test.describe.configure({ mode: 'serial' });

  test('TC1 — Page Load Budget (FCP/LCP/TBT/heap/navigation)', async ({ page }) => {
    test.setTimeout(3 * 60 * 1000);
    const requests: { url: string; method: string; resourceType: string }[] = [];
    const responses: {
      url: string;
      status: number;
      contentType: string;
      contentLength: number;
      cacheControl: string | null;
      etag: string | null;
      age: string | null;
      fromServiceWorker: boolean;
    }[] = [];

    page.on('request', (req: Request) => {
      requests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType() });
    });

    page.on('response', async (res: Response) => {
      const headers = res.headers();
      let size = 0;
      try {
        const body = await res.body();
        size = body.length;
      } catch { /* ignore */ }
      responses.push({
        url: res.url(),
        status: res.status(),
        contentType: headers['content-type'] || '',
        contentLength: size || Number(headers['content-length'] || 0),
        cacheControl: headers['cache-control'] || null,
        etag: headers['etag'] || null,
        age: headers['age'] || null,
        fromServiceWorker: res.fromServiceWorker(),
      });
    });

    const t0 = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    const goTo = Date.now() - t0;

    const perf = await page.evaluate(() => {
      const nav = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming) || {};
      const paint = performance.getEntriesByType('paint') as PerformanceEntry[];
      const fcp = paint.find(p => p.name === 'first-contentful-paint')?.startTime || null;
      const mem = (performance as any).memory || null;
      const resCount = performance.getEntriesByType('resource').length;
      const transferTotal = performance.getEntriesByType('resource')
        .reduce((s, e: any) => s + (e.transferSize || 0), 0);
      const encodedTotal = performance.getEntriesByType('resource')
        .reduce((s, e: any) => s + (e.encodedBodySize || 0), 0);
      return {
        navigation: {
          domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
          loadEvent: nav.loadEventEnd - nav.startTime,
          domComplete: nav.domComplete - nav.startTime,
          ttfb: nav.responseStart - nav.requestStart,
          responseEnd: nav.responseEnd - nav.startTime,
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        },
        fcp,
        memory: mem ? {
          jsHeapSizeLimit: mem.jsHeapSizeLimit,
          totalJSHeapSize: mem.totalJSHeapSize,
          usedJSHeapSize: mem.usedJSHeapSize,
        } : null,
        resourceCount: resCount,
        transferSizeTotal: transferTotal,
        encodedBodySizeTotal: encodedTotal,
      };
    });

    // Approximate LCP via sentinel
    const lcp = await page.evaluate(() => new Promise<number | null>((resolve) => {
      try {
        let val: number | null = null;
        const obs = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length) val = entries[entries.length - 1].startTime;
        });
        obs.observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => { obs.disconnect(); resolve(val); }, 2000);
      } catch { resolve(null); }
    }));

    writeArtifact('tc1_pageload', {
      gotoElapsedMs: goTo,
      perf,
      lcpMs: lcp,
      requestCount: requests.length,
      responseCount: responses.length,
      requests,
      responses,
    });

    expect(perf.navigation.loadEvent).toBeGreaterThan(0);
    expect(perf.fcp).not.toBeNull();
  });

  test('TC2 — Bundle Size Breakdown', async ({ request }) => {
    test.setTimeout(2 * 60 * 1000);
    const assets = [
      { url: `${BASE_URL}/`, label: 'index.html' },
      { url: `${BASE_URL}/static/style.css?v=0.5.23`, label: 'style.css' },
      { url: `${BASE_URL}/static/app.js?v=0.5.23`, label: 'app.js' },
    ];
    const out: any[] = [];
    for (const a of assets) {
      const res = await request.get(a.url);
      const body = await res.body();
      out.push({
        label: a.label,
        url: a.url,
        status: res.status(),
        sizeBytes: body.length,
        cacheControl: res.headers()['cache-control'] || null,
        etag: res.headers()['etag'] || null,
        age: res.headers()['age'] || null,
        contentType: res.headers()['content-type'] || null,
      });
    }
    const total = out.reduce((s, x) => s + x.sizeBytes, 0);
    writeArtifact('tc2_bundle', { totalBytes: total, breakdown: out });
    expect(total).toBeGreaterThan(0);
  });

  test('TC3 — Cache Header Audit (API + static)', async ({ request }) => {
    test.setTimeout(2 * 60 * 1000);
    const endpoints = [
      `${BASE_URL}/api/state`,
      `${BASE_URL}/api/state?league_id=noop`,
      `${BASE_URL}/static/style.css?v=0.5.23`,
      `${BASE_URL}/static/app.js?v=0.5.23`,
      `${BASE_URL}/`,
    ];
    const out: any[] = [];
    for (const url of endpoints) {
      try {
        const res = await request.get(url);
        out.push({
          url,
          status: res.status(),
          cacheControl: res.headers()['cache-control'] || null,
          etag: res.headers()['etag'] || null,
          lastModified: res.headers()['last-modified'] || null,
          vary: res.headers()['vary'] || null,
          cfCacheStatus: res.headers()['cf-cache-status'] || null,
          contentType: res.headers()['content-type'] || null,
        });
      } catch (e: any) {
        out.push({ url, error: String(e) });
      }
    }
    writeArtifact('tc3_cache_headers', out);
  });

  test('TC4 — Idle 5min + Active 5min Network Inventory', async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    const idleLog: { t: number; url: string; method: string; status: number }[] = [];
    const activeLog: typeof idleLog = [];
    let phase: 'idle' | 'active' = 'idle';

    page.on('response', async (res: Response) => {
      const u = res.url();
      if (!u.includes('/api/')) return;
      const entry = { t: Date.now(), url: u, method: res.request().method(), status: res.status() };
      if (phase === 'idle') idleLog.push(entry);
      else activeLog.push(entry);
    });

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Idle 5 minutes (reduced to 180s in observation mode to keep under 20-min cap)
    const IDLE_MS = 3 * 60 * 1000;
    const ACTIVE_MS = 3 * 60 * 1000;

    await page.waitForTimeout(IDLE_MS);

    phase = 'active';
    // Active: try clicking through tabs repeatedly for 3 minutes
    const tabs = ['#draft', '#teams', '#fa', '#league', '#schedule'];
    const start = Date.now();
    while (Date.now() - start < ACTIVE_MS) {
      for (const t of tabs) {
        try {
          await page.evaluate((hash) => { window.location.hash = hash; }, t);
        } catch { /* ignore */ }
        await page.waitForTimeout(2000);
        if (Date.now() - start >= ACTIVE_MS) break;
      }
    }

    // Aggregate: per-endpoint counts
    const summarize = (log: typeof idleLog) => {
      const bucket: Record<string, number> = {};
      for (const e of log) {
        const u = new URL(e.url);
        bucket[u.pathname] = (bucket[u.pathname] || 0) + 1;
      }
      return bucket;
    };
    writeArtifact('tc4_network_audit', {
      idleWindowMs: IDLE_MS,
      activeWindowMs: ACTIVE_MS,
      idleTotal: idleLog.length,
      activeTotal: activeLog.length,
      idlePerEndpoint: summarize(idleLog),
      activePerEndpoint: summarize(activeLog),
      idleLog,
      activeLog,
    });
  });

  test('TC5 — Memory Growth (simulated usage loop)', async ({ page }) => {
    test.setTimeout(8 * 60 * 1000);
    const samples: { t: number; used: number; total: number; limit: number }[] = [];

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const sample = async (label: string) => {
      const mem: any = await page.evaluate(() => {
        const m = (performance as any).memory;
        return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null;
      });
      if (mem) samples.push({ t: Date.now(), ...mem });
      writeArtifact('tc5_mem_progress', { label, samples });
    };

    await sample('baseline');

    // Simulate 5 minutes of tab cycling + hash nav (compressed to stay under budget)
    const LOOP_MS = 5 * 60 * 1000;
    const tabs = ['#draft', '#teams', '#fa', '#league', '#schedule'];
    const loopStart = Date.now();
    let i = 0;
    while (Date.now() - loopStart < LOOP_MS) {
      const t = tabs[i % tabs.length];
      await page.evaluate((h) => { window.location.hash = h; }, t);
      await page.waitForTimeout(1500);
      i += 1;
      if (i % 20 === 0) await sample(`loop_${i}`);
    }

    await sample('final');
    writeArtifact('tc5_mem', { samples });
    expect(samples.length).toBeGreaterThan(0);
  });

  test('TC6 — DOM Mutation + Longtask audit', async ({ page }) => {
    test.setTimeout(3 * 60 * 1000);
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Inject MutationObserver + PerformanceObserver for longtasks
    await page.evaluate(() => {
      (window as any).__mutCount = 0;
      (window as any).__longTasks = [];
      const mo = new MutationObserver((muts) => { (window as any).__mutCount += muts.length; });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            (window as any).__longTasks.push({ startTime: e.startTime, duration: e.duration, name: e.name });
          }
        });
        po.observe({ type: 'longtask', buffered: true });
      } catch { /* longtask unsupported in some builds */ }
    });

    // Stimulate UI: cycle tabs for 60 seconds
    const tabs = ['#draft', '#teams', '#fa', '#league', '#schedule'];
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < 60 * 1000) {
      await page.evaluate((h) => { window.location.hash = h; }, tabs[i % tabs.length]);
      await page.waitForTimeout(1500);
      i += 1;
    }

    const result = await page.evaluate(() => ({
      mutCount: (window as any).__mutCount,
      longTasks: (window as any).__longTasks,
    }));
    writeArtifact('tc6_mutations_longtasks', result);
  });

  test('TC7 — Polling Audit (timers after 3min idle)', async ({ page }) => {
    test.setTimeout(5 * 60 * 1000);
    // Hook setInterval/setTimeout BEFORE app.js runs to capture all registrations
    await page.addInitScript(() => {
      (window as any).__timers = { intervals: [], timeouts: [], intervalsCleared: [], timeoutsCleared: [] };
      const si = window.setInterval;
      const st = window.setTimeout;
      const ci = window.clearInterval;
      const ct = window.clearTimeout;
      window.setInterval = function(fn: any, ms: any, ...rest: any[]) {
        const id = si.call(window, fn, ms, ...rest);
        try {
          (window as any).__timers.intervals.push({ id, ms, stack: new Error().stack?.split('\n').slice(1, 4).join(' | ') });
        } catch { /* */ }
        return id;
      } as any;
      window.setTimeout = function(fn: any, ms: any, ...rest: any[]) {
        const id = st.call(window, fn, ms, ...rest);
        try {
          (window as any).__timers.timeouts.push({ id, ms });
        } catch { /* */ }
        return id;
      } as any;
      window.clearInterval = function(id: any) {
        (window as any).__timers.intervalsCleared.push(id);
        return ci.call(window, id);
      } as any;
      window.clearTimeout = function(id: any) {
        (window as any).__timers.timeoutsCleared.push(id);
        return ct.call(window, id);
      } as any;
    });

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3 * 60 * 1000);

    const timers = await page.evaluate(() => (window as any).__timers);

    // Deduce "still active" intervals
    const activeIntervals = (timers.intervals || []).filter((iv: any) => !timers.intervalsCleared.includes(iv.id));
    writeArtifact('tc7_timers', {
      intervalsTotal: timers.intervals?.length || 0,
      intervalsCleared: timers.intervalsCleared?.length || 0,
      activeIntervals,
      timeoutsTotal: timers.timeouts?.length || 0,
      timeoutsCleared: timers.timeoutsCleared?.length || 0,
    });
  });

  test('TC8 — Reload stall: cold vs warm', async ({ browser }) => {
    test.setTimeout(3 * 60 * 1000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const coldStart = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    const coldMs = Date.now() - coldStart;

    const coldFcp = await page.evaluate(() => {
      const p = performance.getEntriesByType('paint').find((e: any) => e.name === 'first-contentful-paint') as any;
      return p?.startTime || null;
    });

    const warmStart = Date.now();
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
    const warmMs = Date.now() - warmStart;

    const warmFcp = await page.evaluate(() => {
      const p = performance.getEntriesByType('paint').find((e: any) => e.name === 'first-contentful-paint') as any;
      return p?.startTime || null;
    });

    writeArtifact('tc8_cold_warm', {
      coldLoadMs: coldMs, coldFcp,
      warmLoadMs: warmMs, warmFcp,
    });

    await ctx.close();
  });

});
