import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProxyConfiguration } from 'apify';
import type { fetchBoundedHttp } from './bounded-http.js';
import { createMetadataFallback, METADATA_PROXY_LIMITS } from './metadata-fallback.js';
import { RequestBudget } from './request-budget.js';
import { detailFailureDiagnostics } from './detail-failure.js';

const config = '<script>ytcfg.set({"INNERTUBE_API_KEY":"public-key","INNERTUBE_CLIENT_VERSION":"2.0"});</script>';
const challenge = (id: string) => config + `<script>var ytInitialData = ${JSON.stringify({
    currentVideoEndpoint: { watchEndpoint: { videoId: id } },
})}; var ytInitialPlayerResponse = ${JSON.stringify({
    playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" },
})};</script>`;
const metadata = (id: string) => ({ videoDetails: { videoId: id, keywords: ['public'] },
    microformat: { playerMicroformatRenderer: { category: 'Science', publishDate: '2026-10-01T12:00:00Z' } } });
const fakeProxy = { newUrl: async () => 'http://PRIVATE_PROXY_PASSWORD@proxy.test:8000' } as unknown as ProxyConfiguration;

function fixture(enabled = true, body?: (id: string, proxy: boolean) => unknown) {
    const requests: Parameters<typeof fetchBoundedHttp>[0][] = [];
    let creations = 0;
    const fallback = createMetadataFallback({ enabled,
        createResidentialProxy: async () => { creations += 1; return fakeProxy; },
        transport: async (options, budget) => {
            budget.take(); requests.push(options);
            const id = JSON.parse(options.body!).videoId;
            return { statusCode: 200, url: options.url,
                body: JSON.stringify(body ? body(id, Boolean(options.proxyUrl)) : metadata(id)) };
        },
    });
    return { fallback, requests, creations: () => creations };
}

test('metadata fallback is opt-in and direct success never initializes a paid proxy', async () => {
    const disabled = fixture(false);
    await assert.rejects(disabled.fallback.fetchPlayer('A', challenge('A'), new RequestBudget(4)));
    assert.equal(disabled.creations(), 0);
    assert.equal(disabled.requests.length, 0);
    const direct = fixture(true);
    assert.equal((await direct.fallback.fetchPlayer('A', config, new RequestBudget(4))).videoDetails.videoId, 'A');
    assert.equal(direct.creations(), 0);
    assert.equal(direct.requests[0].proxyUrl, undefined);
});

test('only compact player metadata uses the explicit fallback, sharing the channel attempt budget', async () => {
    const check = fixture();
    const budget = new RequestBudget(4);
    for (const id of ['A', 'B']) await check.fallback.fetchPlayer(id, challenge(id), budget);
    assert.equal(check.creations(), 1);
    assert.equal(budget.used, 2);
    for (const request of check.requests) {
        const url = new URL(request.url);
        assert.equal(url.pathname, '/youtubei/v1/player');
        assert.equal(url.searchParams.get('fields'), 'videoDetails,microformat,playabilityStatus');
        assert.equal(request.method, 'POST');
        assert.ok(request.proxyUrl);
        assert.equal(request.maximumRedirects, 0);
        assert.equal(request.maximumResponseBytes, 32_768);
    }
    assert.equal(check.fallback.snapshot().successful, 2);
    assert.equal(check.fallback.snapshot().requests, 2);
    assert.doesNotMatch(JSON.stringify(check.fallback.snapshot()), /PRIVATE_|proxy\.test/);
});

test('direct API challenge and fallback each consume the same shared quota', async () => {
    const check = fixture(true, (id, proxy) => proxy ? metadata(id) : {
        playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Confirm you are not a bot' },
    });
    const budget = new RequestBudget(2);
    await check.fallback.fetchPlayer('A', config, budget);
    assert.equal(budget.used, 2);
    assert.equal(check.requests.filter(request => request.proxyUrl).length, 1);
    assert.equal(check.requests.filter(request => !request.proxyUrl).length, 1);
});

test('one unsuccessful fallback stops further paid attempts only for that channel', async () => {
    const check = fixture(true, () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Confirm you are not a bot PRIVATE_TOKEN' } }));
    const first = new RequestBudget(10);
    for (const id of ['A', 'B', 'C']) await assert.rejects(check.fallback.fetchPlayer(id, challenge(id), first));
    assert.equal(check.requests.length, 1);
    assert.equal(first.used, 1);
    assert.equal(check.fallback.snapshot().skipped, 2);
    await assert.rejects(check.fallback.fetchPlayer('D', challenge('D'), new RequestBudget(4)));
    assert.equal(check.requests.length, 2);
    assert.equal(check.creations(), 1);
});

test('generic sign-in, private/age restrictions and malformed responses do not trigger a paid fallback', async () => {
    for (const data of [{ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Please sign in' } },
        { playabilityStatus: { status: 'AGE_CHECK_REQUIRED', reason: 'Verify age' } },
        { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'This video is private' } }, null]) {
        const check = fixture(true, () => data);
        await assert.rejects(check.fallback.fetchPlayer('A', config, new RequestBudget(4)));
        assert.equal(check.creations(), 0);
        assert.equal(check.requests.length, 1);
    }
});

test('unidentified or foreign fallback metadata fails and stops further proxy calls', async () => {
    for (const value of [metadata('OTHER'), { microformat: { playerMicroformatRenderer: { category: 'Science' } } }]) {
        const check = fixture(true, () => value);
        const budget = new RequestBudget(4);
        await assert.rejects(check.fallback.fetchPlayer('A', challenge('A'), budget), error => {
            assert.match(detailFailureDiagnostics(error).category, /^video-identity-/);
            return true;
        });
        await assert.rejects(check.fallback.fetchPlayer('B', challenge('B'), budget));
        assert.equal(check.requests.length, 1);
        assert.equal(check.fallback.snapshot().successful, 0);
    }
});

test('ignored partial-response requests cannot silently return a media payload', async () => {
    const check = fixture(true, id => ({ ...metadata(id), streamingData: { PRIVATE_MEDIA_URL: 'private' } }));
    await assert.rejects(check.fallback.fetchPlayer('A', challenge('A'), new RequestBudget(4)), error => {
        assert.equal(detailFailureDiagnostics(error).category, 'invalid-source-json');
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/);
        return true;
    });
    assert.equal(check.fallback.snapshot().successful, 0);
});

test('five-attempt cap and aggregate response-byte budget constrain each channel', async () => {
    const small = fixture();
    const budget = new RequestBudget(10);
    for (const id of ['A', 'B', 'C', 'D', 'E']) await small.fallback.fetchPlayer(id, challenge(id), budget);
    await assert.rejects(small.fallback.fetchPlayer('F', challenge('F'), budget));
    assert.equal(small.requests.length, METADATA_PROXY_LIMITS.attemptsPerChannel);
    const large = fixture(true, id => ({ ...metadata(id), videoDetails: { videoId: id, shortDescription: 'x'.repeat(30_000) } }));
    const bytes = new RequestBudget(5);
    await large.fallback.fetchPlayer('A', challenge('A'), bytes);
    await large.fallback.fetchPlayer('B', challenge('B'), bytes);
    // The transport receives only the aggregate remainder on the third call.
    await large.fallback.fetchPlayer('C', challenge('C'), bytes);
    assert.ok(large.requests[2].maximumResponseBytes! < 6_000);
    await assert.rejects(large.fallback.fetchPlayer('D', challenge('D'), bytes));
    assert.equal(large.requests.length, 3);
});

test('failed proxy initialization is sanitized and never repeated or replaced with a direct request', async () => {
    let creations = 0;
    let requests = 0;
    const fallback = createMetadataFallback({ enabled: true,
        createResidentialProxy: async () => { creations += 1; throw new Error('PRIVATE_PASSWORD'); },
        transport: async () => { requests += 1; throw new Error('Must not request.'); },
    });
    for (const id of ['A', 'B']) await assert.rejects(fallback.fetchPlayer(id, challenge(id), new RequestBudget(4)), error => {
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/); return true;
    });
    assert.equal(creations, 1);
    assert.equal(requests, 0);
    assert.equal(fallback.snapshot().setupFailed, true);
});

test('an exhausted quota or stalled proxy initialization cannot escape the channel deadline', async () => {
    const check = fixture();
    const exhausted = new RequestBudget(1); exhausted.take();
    await assert.rejects(check.fallback.fetchPlayer('A', challenge('A'), exhausted));
    assert.equal(check.creations(), 0);
    const stalled = createMetadataFallback({ enabled: true,
        createResidentialProxy: () => new Promise(() => {}),
        transport: async () => { throw new Error('Must not request.'); },
    });
    await assert.rejects(stalled.fetchPlayer('A', challenge('A'), new RequestBudget(2, 15)), error =>
        detailFailureDiagnostics(error).category === 'time-limit');
});
