import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProxyConfiguration } from 'apify';
import type { fetchBoundedHttp } from './bounded-http.js';
import { BudgetLimitError, RequestBudget } from './request-budget.js';
import { getYouTubeSession, resolveYouTubeProxyUrl } from './youtube-session.js';
import { fetchYouTubePage, fetchYouTubePlayerData, fetchYouTubeContinuation } from './youtube-http.js';
import { detailFailureDiagnostics } from './detail-failure.js';

const config = { INNERTUBE_API_KEY: 'public-fixture-key', INNERTUBE_CLIENT_VERSION: '2.20261002.00.00',
    VISITOR_DATA: 'PUBLIC_VISITOR', INNERTUBE_CONTEXT: { client: { clientName: 'WEB', userAgent: 'Public UA', hl: 'en', gl: 'US' } } };
const sourceHtml = `<title>Public video - YouTube</title><script>var ytInitialData = {};</script>`
    + `<script>ytcfg.set(${JSON.stringify(config)});</script>`;
const fakeProxy = (newUrl: (id?: string) => Promise<string | undefined>) => ({ newUrl }) as unknown as ProxyConfiguration;

test('anonymous sessions are stable within one budget, isolated between budgets and not retained in budget JSON', () => {
    const budget = new RequestBudget(3);
    const session = getYouTubeSession(budget);
    assert.equal(getYouTubeSession(budget), session);
    assert.match(session.proxySessionId, /^yt_[a-f0-9]{32}$/);
    assert.deepEqual(session.headerToken, {});
    const other = getYouTubeSession(new RequestBudget(3));
    assert.notEqual(other.proxySessionId, session.proxySessionId);
    assert.notEqual(other.headerToken, session.headerToken);
    assert.equal(budget.used, 0);
    assert.ok(!JSON.stringify(budget).includes(session.proxySessionId));
});

test('watch, player and continuation calls reuse one explicit proxy session and anonymous browse context', async () => {
    const ids: Array<string | undefined> = [];
    const proxy = fakeProxy(async id => { ids.push(id); return 'http://private-proxy-password@proxy.example'; });
    const budget = new RequestBudget(3);
    const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
        activeBudget.take();
        assert.equal(activeBudget, budget);
        assert.equal(options.proxyUrl, 'http://private-proxy-password@proxy.example');
        if (options.method === 'POST') {
            const body = JSON.parse(options.body!);
            assert.equal(options.headers['x-goog-visitor-id'], 'PUBLIC_VISITOR');
            assert.equal(options.headers['user-agent'], 'Public UA');
            assert.equal(body.context.client.visitorData, 'PUBLIC_VISITOR');
            return { statusCode: 200, url: options.url, body: JSON.stringify({ videoDetails: { videoId: 'OWNED' } }) };
        }
        return { statusCode: 200, url: options.url, body: sourceHtml };
    };
    const page = await fetchYouTubePage('https://www.youtube.com/watch?v=OWNED', proxy, 1, budget, transport);
    await fetchYouTubePlayerData('OWNED', page.html, proxy, 1, budget, transport);
    await fetchYouTubeContinuation('public-continuation', page.html, proxy, budget, transport);
    assert.equal(budget.used, 3);
    assert.equal(ids.length, 3);
    assert.ok(ids.every(id => id === getYouTubeSession(budget).proxySessionId));
});

test('page retries keep their anonymous proxy session without consuming extra attempt slots', async () => {
    const ids: Array<string | undefined> = [];
    const proxy = fakeProxy(async id => { ids.push(id); return 'http://proxy.example'; });
    const budget = new RequestBudget(2);
    let calls = 0;
    const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
        activeBudget.take();
        calls += 1;
        return { statusCode: calls === 1 ? 503 : 200, url: options.url, body: sourceHtml };
    };
    await fetchYouTubePage('https://www.youtube.com/watch?v=OWNED', proxy, 2, budget, transport);
    assert.equal(calls, 2);
    assert.equal(budget.used, 2);
    assert.equal(ids[0], ids[1]);
});

test('proxy setup errors and missing URLs are sanitized and never trigger a direct fallback', async () => {
    for (const proxy of [fakeProxy(async () => { throw new Error('PRIVATE_PASSWORD PRIVATE_TOKEN'); }),
        fakeProxy(async () => undefined)]) {
        const budget = new RequestBudget(1);
        let calls = 0;
        const transport: typeof fetchBoundedHttp = async () => { calls += 1; throw new Error('Transport must not run.'); };
        await assert.rejects(fetchYouTubePage('https://www.youtube.com/watch?v=OWNED', proxy, 1, budget, transport), error => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(error.message, /PRIVATE_|password|token/i);
            assert.equal(error.cause, undefined);
            return true;
        });
        assert.equal(calls, 0);
        assert.equal(budget.used, 0);
    }
});

test('stalled or late proxy setup cannot escape the channel deadline or start an HTTP request', async () => {
    const pending = fakeProxy(() => new Promise<string>(() => {}));
    await assert.rejects(resolveYouTubeProxyUrl(pending, new RequestBudget(1, 15)), error =>
        error instanceof BudgetLimitError && error.reason === 'time-limit');
    let now = 0;
    const budget = new RequestBudget(1, 100, () => now);
    const late = fakeProxy(async () => { now = 100; return 'http://proxy.example'; });
    await assert.rejects(resolveYouTubeProxyUrl(late, budget), error =>
        error instanceof BudgetLimitError && error.reason === 'time-limit');
    assert.equal(budget.used, 0);
});

test('direct mode remains direct and does not change request-attempt accounting', async () => {
    const budget = new RequestBudget(1);
    assert.equal(await resolveYouTubeProxyUrl(undefined, budget), undefined);
    assert.equal(budget.used, 0);
    const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
        assert.equal(options.proxyUrl, undefined);
        activeBudget.take();
        return { statusCode: 200, url: options.url, body: sourceHtml };
    };
    await fetchYouTubePage('https://www.youtube.com/watch?v=OWNED', undefined, 1, budget, transport);
    assert.equal(budget.used, 1);
});

test('explicit access restrictions with no metadata stop unchanged retries but keep safe status diagnostics', async () => {
    for (const status of ['LOGIN_REQUIRED', 'AGE_CHECK_REQUIRED', 'CONTENT_CHECK_REQUIRED']) {
        const budget = new RequestBudget(3);
        const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
            activeBudget.take();
            return { statusCode: 200, url: options.url,
                body: JSON.stringify({ playabilityStatus: { status, reason: 'PRIVATE_REASON PRIVATE_TOKEN' } }) };
        };
        await assert.rejects(fetchYouTubePlayerData('OWNED', sourceHtml, undefined, 3, budget, transport), error => {
            assert.deepEqual(detailFailureDiagnostics(error), { category: 'player-metadata-missing', playerStatus: status });
            assert.ok(error instanceof Error);
            assert.doesNotMatch(error.message, /PRIVATE_|after 3/);
            return true;
        });
        assert.equal(budget.used, 1);
    }
});
