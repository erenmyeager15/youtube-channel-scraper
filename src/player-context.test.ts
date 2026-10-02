import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPlayerApiConfig, fetchYouTubePlayerData } from './youtube-http.js';
import { RequestBudget } from './request-budget.js';
import { detailFailureDiagnostics } from './detail-failure.js';
import type { fetchBoundedHttp } from './bounded-http.js';

const base = { INNERTUBE_API_KEY: 'public-fixture-key', INNERTUBE_CLIENT_VERSION: '2.20261002.00.00' };
const html = (config: Record<string, unknown>) => `<script>ytcfg.set(${JSON.stringify(config)});</script>`;

test('player requests carry only validated anonymous page context, not account or authentication fields', async () => {
    const source = html({ ...base, VISITOR_DATA: 'PUBLIC_VISITOR', INNERTUBE_CONTEXT: {
        client: { clientName: 'WEB', visitorData: 'OTHER_VISITOR', userAgent: 'Public fixture UA', hl: 'en-GB', gl: 'in',
            remoteHost: 'PRIVATE_IP', authorization: 'PRIVATE_CLIENT_AUTH' },
        user: { onBehalfOfUser: 'PRIVATE_ACCOUNT' }, request: { sessionIndex: 'PRIVATE_SESSION' },
    }, DATASYNC_ID: 'PRIVATE_ID', SESSION_INDEX: 7, authorization: 'PRIVATE_AUTH', LOGGED_IN: true });
    const config = extractPlayerApiConfig(source)!;
    assert.deepEqual(config.clientContext, { visitorData: 'PUBLIC_VISITOR', userAgent: 'Public fixture UA', hl: 'en-GB', gl: 'IN' });
    const budget = new RequestBudget(1);
    const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
        activeBudget.take();
        assert.equal(activeBudget, budget);
        assert.equal(options.headers['x-goog-visitor-id'], 'PUBLIC_VISITOR');
        assert.equal(options.headers['user-agent'], 'Public fixture UA');
        assert.equal(options.headers.cookie, 'SOCS=CAI');
        const body = JSON.parse(options.body!);
        assert.deepEqual(body.context.client, { clientName: 'WEB', clientVersion: base.INNERTUBE_CLIENT_VERSION,
            hl: 'en-GB', gl: 'IN', visitorData: 'PUBLIC_VISITOR', userAgent: 'Public fixture UA' });
        assert.equal(body.videoId, 'OWNED');
        assert.doesNotMatch(JSON.stringify({ config, options }), /PRIVATE_/);
        return { statusCode: 200, url: options.url, body: JSON.stringify({ videoDetails: { videoId: 'OWNED' } }) };
    };
    await fetchYouTubePlayerData('OWNED', source, undefined, 1, budget, transport);
    assert.equal(budget.used, 1);
});

test('legacy public configuration remains compatible and unsafe context values never become headers', () => {
    assert.deepEqual(extractPlayerApiConfig(html(base)), { apiKey: base.INNERTUBE_API_KEY, clientVersion: base.INNERTUBE_CLIENT_VERSION });
    const unsafe = html({ ...base, VISITOR_DATA: 'visitor\r\nPRIVATE_HEADER', INNERTUBE_CONTEXT: {
        client: { clientName: 'WEB', userAgent: 'agent\nPRIVATE_HEADER', hl: 'en bad', gl: 'USA' },
    } });
    assert.deepEqual(extractPlayerApiConfig(unsafe), extractPlayerApiConfig(html(base)));
    for (const config of [{ ...base, INNERTUBE_CLIENT_VERSION: '2.0\r\nunsafe' },
        { ...base, INNERTUBE_API_KEY: 'not a public key' }]) {
        assert.equal(extractPlayerApiConfig(html(config)), null);
    }
    assert.deepEqual(extractPlayerApiConfig(html({ ...base, INNERTUBE_CONTEXT: {
        client: { clientName: 'OTHER', visitorData: 'UNTRUSTED_CONTEXT', userAgent: 'OTHER UA' },
    } })), extractPlayerApiConfig(html(base)));
});

test('oversized or malformed page context fails closed without changing the bounded legacy request', () => {
    const oversized = html({ ...base, INNERTUBE_CONTEXT: { padding: 'x'.repeat(262_144),
        client: { clientName: 'WEB', visitorData: 'UNTRUSTED_OVERSIZED' } } });
    const malformed = html(base) + '<script>{"INNERTUBE_CONTEXT":{"client":not-json}}</script>';
    assert.deepEqual(extractPlayerApiConfig(oversized), extractPlayerApiConfig(html(base)));
    assert.deepEqual(extractPlayerApiConfig(malformed), extractPlayerApiConfig(html(base)));
});

test('missing metadata records only a whitelisted player status, never its reason text or source body', async () => {
    for (const status of ['LOGIN_REQUIRED', 'UNPLAYABLE', 'PRIVATE_RESPONSE_STATUS']) {
        const budget = new RequestBudget(1);
        const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
            activeBudget.take();
            return { statusCode: 200, url: options.url, body: JSON.stringify({
                playabilityStatus: { status, reason: 'PRIVATE_REASON PRIVATE_TOKEN' },
            }) };
        };
        await assert.rejects(fetchYouTubePlayerData('OWNED', html(base), undefined, 1, budget, transport), (error) => {
            assert.deepEqual(detailFailureDiagnostics(error), { category: 'player-metadata-missing',
                ...(status === 'PRIVATE_RESPONSE_STATUS' ? {} : { playerStatus: status }) });
            assert.doesNotMatch(JSON.stringify(detailFailureDiagnostics(error)), /PRIVATE_/);
            return true;
        });
        assert.equal(budget.used, 1);
    }
});

test('playability restrictions do not discard public identified metadata when it is actually present', async () => {
    const player = { playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: { videoId: 'OWNED', keywords: ['research'] },
        microformat: { playerMicroformatRenderer: { category: 'Science', publishDate: '2026-10-01' } } };
    const transport: typeof fetchBoundedHttp = async (options, budget) => {
        budget.take();
        return { statusCode: 200, url: options.url, body: JSON.stringify(player) };
    };
    assert.deepEqual(await fetchYouTubePlayerData('OWNED', html(base), undefined, 1, new RequestBudget(1), transport), player);
});

test('invalid player JSON objects and HTTP errors preserve fixed failure codes and the attempt budget', async () => {
    for (const body of ['null', '[]', 'not-json']) {
        const transport: typeof fetchBoundedHttp = async (options, budget) => {
            budget.take();
            return { statusCode: 200, url: options.url, body };
        };
        await assert.rejects(fetchYouTubePlayerData('OWNED', html(base), undefined, 1, new RequestBudget(1), transport), (error) => {
            assert.equal(detailFailureDiagnostics(error).category, 'invalid-source-json');
            return true;
        });
    }
    const transport: typeof fetchBoundedHttp = async (options, budget) => {
        budget.take();
        return { statusCode: 429, url: options.url, body: 'PRIVATE_HTTP_BODY' };
    };
    await assert.rejects(fetchYouTubePlayerData('OWNED', html(base), undefined, 1, new RequestBudget(1), transport), (error) => {
        assert.equal(detailFailureDiagnostics(error).category, 'source-http-status');
        return true;
    });
});

test('confirmed bot challenges stop repeated player calls only inside the affected channel budget', async () => {
    let calls = 0;
    const transport: typeof fetchBoundedHttp = async (options, budget) => {
        budget.take(); calls += 1;
        return { statusCode: 200, url: options.url, body: JSON.stringify({
            playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot. PRIVATE_TOKEN" },
        }) };
    };
    const budget = new RequestBudget(10);
    for (const id of ['FIRST', 'SECOND', 'THIRD']) {
        await assert.rejects(fetchYouTubePlayerData(id, html(base), undefined, 3, budget, transport), error => {
            assert.deepEqual(detailFailureDiagnostics(error), { category: 'source-automation-check', playerStatus: 'LOGIN_REQUIRED' });
            assert.doesNotMatch(JSON.stringify(error), /PRIVATE_TOKEN/);
            return true;
        });
    }
    assert.equal(calls, 1);
    assert.equal(budget.used, 1);
    const other = new RequestBudget(10);
    await assert.rejects(fetchYouTubePlayerData('OTHER_CHANNEL', html(base), undefined, 1, other, transport));
    assert.equal(calls, 2);
    assert.equal(other.used, 1);
});

test('generic login and age/private restrictions never poison the next public video request', async () => {
    for (const [status, reason] of [
        ['LOGIN_REQUIRED', 'Please sign in'], ['LOGIN_REQUIRED', 'This video is private'],
        ['AGE_CHECK_REQUIRED', 'Confirm your age'], ['UNPLAYABLE', 'Not a bot literal without a login challenge'],
    ]) {
        let calls = 0;
        const budget = new RequestBudget(4);
        const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
            activeBudget.take(); calls += 1;
            return { statusCode: 200, url: options.url, body: JSON.stringify(calls === 1
                ? { playabilityStatus: { status, reason } }
                : { videoDetails: { videoId: 'SECOND', keywords: ['public'] } }) };
        };
        await assert.rejects(fetchYouTubePlayerData('FIRST', html(base), undefined, 1, budget, transport));
        const result = await fetchYouTubePlayerData('SECOND', html(base), undefined, 1, budget, transport);
        assert.equal(result.videoDetails.videoId, 'SECOND');
        assert.equal(calls, 2);
    }
});

test('present identified metadata is retained even alongside an automation-related playback message', async () => {
    let calls = 0;
    const budget = new RequestBudget(2);
    const transport: typeof fetchBoundedHttp = async (options, activeBudget) => {
        activeBudget.take(); calls += 1;
        return { statusCode: 200, url: options.url, body: JSON.stringify({
            playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Confirm you're not a bot" },
            videoDetails: { videoId: 'OWNED', keywords: ['public'] },
        }) };
    };
    await fetchYouTubePlayerData('OWNED', html(base), undefined, 1, budget, transport);
    await fetchYouTubePlayerData('OWNED', html(base), undefined, 1, budget, transport);
    assert.equal(calls, 2);
});

test('a verified watch-page bot challenge avoids an already-known redundant player request', async () => {
    const budget = new RequestBudget(4);
    const source = html(base) + '<script>var ytInitialData = '
        + JSON.stringify({ currentVideoEndpoint: { watchEndpoint: { videoId: 'OWNED' } } }) + ';</script>'
        + '<script>var ytInitialPlayerResponse = '
        + JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Confirm you're not a bot PRIVATE_TOKEN" } }) + ';</script>';
    let calls = 0;
    const transport: typeof fetchBoundedHttp = async () => { calls += 1; throw new Error('Must not request.'); };
    await assert.rejects(fetchYouTubePlayerData('OWNED', source, undefined, 3, budget, transport), error => {
        assert.deepEqual(detailFailureDiagnostics(error), { category: 'source-automation-check', playerStatus: 'LOGIN_REQUIRED' });
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_TOKEN/);
        return true;
    });
    await assert.rejects(fetchYouTubePlayerData('NEXT', html(base), undefined, 1, budget, transport));
    assert.equal(calls, 0);
    assert.equal(budget.used, 0);
});

test('unbound or conflicting HTML challenges do not suppress an identified public player response', async () => {
    const challenge = '<script>var ytInitialPlayerResponse = '
        + JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Confirm you're not a bot" } }) + ';</script>';
    const transport: typeof fetchBoundedHttp = async (options, budget) => {
        budget.take();
        return { statusCode: 200, url: options.url, body: JSON.stringify({ videoDetails: { videoId: 'OWNED' } }) };
    };
    for (const identity of ['', '<meta property="og:url" content="https://www.youtube.com/watch?v=OTHER">']) {
        const budget = new RequestBudget(1);
        await fetchYouTubePlayerData('OWNED', html(base) + identity + challenge, undefined, 1, budget, transport);
        assert.equal(budget.used, 1);
    }
});
