import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectContentSection, type CollectContentSectionOptions } from './content-collector.js';
import { type ContentItem } from './content-pagination.js';
import { extractVideos } from './youtube-http.js';

interface Row {
    id: string;
    decision?: 'include' | 'exclude' | 'uncertain';
}

const video = (id: string, extra: ContentItem = {}) => ({ videoRenderer: {
    videoId: id, title: { simpleText: id }, ...extra,
} });
const token = (value: string) => ({ continuationItemRenderer: {
    continuationEndpoint: { continuationCommand: { token: value } },
} });
const initial = (entries: ContentItem[]) => ({
    metadata: { channelMetadataRenderer: { externalId: 'UC_OWNER' } },
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
        selected: true,
        endpoint: { commandMetadata: { webCommandMetadata: { url: '/channel/UC_OWNER/videos' } } },
        content: { richGridRenderer: { contents: entries } },
    } }] } },
});
const next = (entries: ContentItem[]) => ({ onResponseReceivedActions: [{
    appendContinuationItemsAction: { targetId: 'browse-feed', continuationItems: entries },
}] });
const options = (entries: ContentItem[], override: Partial<CollectContentSectionOptions<Row>> = {}): CollectContentSectionOptions<Row> => ({
    section: 'videos',
    initialData: initial(entries),
    expectedChannelId: 'UC_OWNER',
    maxPages: 1,
    maxRows: 100,
    fetchContinuation: async () => { throw new Error('Unexpected continuation request.'); },
    mapItems: (items) => extractVideos({ contents: items }).map((row) => ({ id: row.videoId })),
    key: (row) => row.id,
    ...override,
});

test('the one-page default reports a bounded initial feed, not a full channel archive', async () => {
    const result = await collectContentSection(options([video('one'), token('NEXT')]));
    assert.deepEqual(result.rows, [{ id: 'one' }]);
    assert.equal(result.coverage.status, 'page-limit');
    assert.equal(result.coverage.pagesFetched, 1);
    assert.equal(result.coverage.morePagesAvailable, true);
    assert.equal(result.coverage.selectedTabVerified, true);
    assert.equal(result.coverage.complete, false);
});

test('hard page and row limits reject invalid values before any request', async () => {
    for (const maxPages of [0, 6, 1.5, NaN, Infinity]) {
        await assert.rejects(collectContentSection(options([], { maxPages })), /maxPages/);
    }
    for (const maxRows of [0, 101, 1.5, NaN, Infinity]) {
        await assert.rejects(collectContentSection(options([], { maxRows })), /maxRows/);
    }
    let requests = 0;
    const result = await collectContentSection(options([video('0'), token('PAGE_1')], {
        maxPages: 5,
        fetchContinuation: async () => {
            requests += 1;
            return next([video(String(requests)), token(`PAGE_${requests + 1}`)]);
        },
    }));
    assert.equal(requests, 4);
    assert.equal(result.coverage.pagesFetched, 5);
    assert.equal(result.coverage.status, 'page-limit');
});

test('selected-row caps stop continuation requests and detect overflow inside a page', async () => {
    const capped = await collectContentSection(options([video('one'), video('two'), token('NEXT')], { maxRows: 1 }));
    assert.deepEqual(capped.rows.map((row) => row.id), ['one']);
    assert.equal(capped.coverage.rowsSeen, 2);
    assert.equal(capped.coverage.rowsSelected, 1);
    assert.equal(capped.coverage.status, 'row-limit');
    const noMorePages = await collectContentSection(options([video('one'), video('two')], { maxRows: 1 }));
    assert.equal(noMorePages.coverage.status, 'row-limit');
    assert.equal(noMorePages.coverage.morePagesAvailable, false);
    const exactEnd = await collectContentSection(options([video('one')], { maxRows: 1 }));
    assert.equal(exactEnd.coverage.status, 'exhausted');
    assert.equal(exactEnd.coverage.complete, true);
});

test('excluded rows do not consume the row cap or prematurely stop a later relevant page', async () => {
    const requested: string[] = [];
    const result = await collectContentSection(options([video('old-one'), token('NEXT_1')], {
        maxPages: 3,
        maxRows: 1,
        accept: (row) => row.id.startsWith('old') ? 'exclude' : 'include',
        fetchContinuation: async (value) => {
            requested.push(value);
            return value === 'NEXT_1'
                ? next([video('old-two'), token('NEXT_2')])
                : next([video('relevant')]);
        },
    }));
    assert.deepEqual(requested, ['NEXT_1', 'NEXT_2']);
    assert.deepEqual(result.rows, [{ id: 'relevant' }]);
    assert.equal(result.coverage.filteredRows, 2);
    assert.equal(result.coverage.rowsSeen, 3);
    assert.equal(result.coverage.status, 'exhausted');
    assert.equal(result.coverage.complete, true);
});

test('unknown-date rows remain visible and prevent a misleading complete date-window claim', async () => {
    const result = await collectContentSection(options([video('unknown'), video('known')], {
        accept: (row) => row.id === 'unknown' ? 'uncertain' : 'include',
    }));
    assert.deepEqual(result.rows.map((row) => row.id), ['unknown', 'known']);
    assert.equal(result.coverage.uncertainRows, 1);
    assert.equal(result.coverage.status, 'exhausted');
    assert.equal(result.coverage.complete, false);
});

test('fully date-excluded feeds are exhausted rather than falsely source-empty', async () => {
    const result = await collectContentSection(options([video('outside')], { accept: () => 'exclude' }));
    assert.deepEqual(result.rows, []);
    assert.equal(result.coverage.status, 'exhausted');
    assert.equal(result.coverage.filteredRows, 1);
    assert.equal(result.coverage.complete, true);
});

test('duplicates across and within pages count once without losing progressing pages', async () => {
    const result = await collectContentSection(options([video('one'), video('one'), token('NEXT')], {
        maxPages: 2,
        mapItems: (items) => items.map((item) => ({ id: item.videoRenderer.videoId })),
        fetchContinuation: async () => next([video('one'), video('two')]),
    }));
    assert.deepEqual(result.rows.map((row) => row.id), ['one', 'two']);
    assert.equal(result.coverage.rowsSeen, 2);
    assert.equal(result.coverage.duplicateRows, 2);
    assert.equal(result.coverage.status, 'exhausted');
    assert.equal(result.coverage.complete, true);
});

test('repeated continuation tokens stop without reissuing the same request', async () => {
    let requests = 0;
    const result = await collectContentSection(options([video('one'), token('REPEAT')], {
        maxPages: 5,
        fetchContinuation: async () => { requests += 1; return next([video('two'), token('REPEAT')]); },
    }));
    assert.equal(requests, 1);
    assert.equal(result.coverage.status, 'repeated-continuation');
    assert.equal(result.coverage.complete, false);
    assert.deepEqual(result.rows.map((row) => row.id), ['one', 'two']);
});

test('a duplicate-only continuation with another token stops at no progress', async () => {
    let requests = 0;
    const result = await collectContentSection(options([video('one'), token('NEXT_1')], {
        maxPages: 5,
        fetchContinuation: async () => { requests += 1; return next([video('one'), token('NEXT_2')]); },
    }));
    assert.equal(requests, 1);
    assert.equal(result.coverage.status, 'no-progress');
    assert.equal(result.coverage.duplicateRows, 1);
    assert.equal(result.coverage.rowsSelected, 1);
});

test('verified empty source containers are complete; empty unrecognized documents are not', async () => {
    const empty = await collectContentSection(options([]));
    assert.equal(empty.coverage.status, 'empty');
    assert.equal(empty.coverage.complete, true);
    assert.equal(empty.coverage.morePagesAvailable, false);
    const missing = await collectContentSection(options([], { initialData: {} }));
    assert.equal(missing.coverage.status, 'unsupported');
    assert.equal(missing.coverage.complete, false);
    assert.equal(missing.coverage.selectedTabVerified, false);
    assert.equal(missing.coverage.morePagesAvailable, null);
});

test('unsupported partial shapes retain scoped rows but never follow their continuation', async () => {
    const result = await collectContentSection(options([video('safe'), { unknownRenderer: {} }, token('UNVERIFIED')], {
        maxPages: 5,
    }));
    assert.deepEqual(result.rows, [{ id: 'safe' }]);
    assert.equal(result.coverage.status, 'unsupported');
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.morePagesAvailable, null);
});

test('ambiguous continuation shapes retain safe rows and never guess a token', async () => {
    const result = await collectContentSection(options([video('safe'), token('A'), token('B')], { maxPages: 5 }));
    assert.deepEqual(result.rows, [{ id: 'safe' }]);
    assert.equal(result.coverage.status, 'ambiguous-continuation');
    assert.equal(result.coverage.morePagesAvailable, null);
    assert.equal(result.coverage.complete, false);
});

test('request/time limits and arbitrary errors preserve rows and expose no raw error data', async () => {
    for (const reason of ['request-limit', 'time-limit', 'some-secret-source-error']) {
        const error = Object.assign(new Error('Private token SENSITIVE_NEXT or body payload'), { reason });
        const result = await collectContentSection(options([video('safe'), token('SENSITIVE_NEXT')], {
            maxPages: 2,
            fetchContinuation: async () => { throw error; },
        }));
        assert.deepEqual(result.rows, [{ id: 'safe' }]);
        assert.equal(result.coverage.status, reason === 'some-secret-source-error' ? 'failed' : reason);
        assert.equal(result.coverage.pagesFetched, 1);
        assert.equal(result.coverage.complete, false);
        assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_NEXT|Private token|payload|some-secret-source-error/);
    }
});

test('unsupported continuation responses preserve prior records without asserting exhaustion', async () => {
    const result = await collectContentSection(options([video('safe'), token('NEXT')], {
        maxPages: 2,
        fetchContinuation: async () => ({ arbitrary: { videoRenderer: { videoId: 'suggested' } } }),
    }));
    assert.deepEqual(result.rows, [{ id: 'safe' }]);
    assert.equal(result.coverage.status, 'unsupported');
    assert.equal(result.coverage.pagesFetched, 2);
    assert.equal(result.coverage.morePagesAvailable, null);
});

test('mapping failures cannot imply complete empty content and preserve previously mapped rows', async () => {
    const unmappable = await collectContentSection(options([video('one')], { mapItems: () => [] }));
    assert.equal(unmappable.coverage.status, 'unsupported');
    assert.equal(unmappable.coverage.complete, false);
    const malformed = await collectContentSection(options([video('one'), video('two')], {
        key: (row) => row.id === 'two' ? '' : row.id,
    }));
    assert.deepEqual(malformed.rows, [{ id: 'one' }]);
    assert.equal(malformed.coverage.status, 'failed');
    assert.equal(malformed.coverage.errorCategory, 'item-mapping');
});

test('selected-tab and nested recommendation scoping carries through to collected output', async () => {
    const fixture = initial([video('owned', {
        title: { simpleText: 'Owned', recommendation: video('nested') },
        recommendations: [video('suggested'), token('RECOMMENDED_NEXT')],
    })]);
    const data: ContentItem = { ...fixture, header: video('header-video'), engagementPanels: [video('panel-video')] };
    data.contents.twoColumnBrowseResultsRenderer.tabs.push({ tabRenderer: {
        selected: false,
        endpoint: { commandMetadata: { webCommandMetadata: { url: '/channel/UC_OWNER/shorts' } } },
        content: { richGridRenderer: { contents: [video('other-tab')] } },
    } });
    const result = await collectContentSection(options([], { initialData: data }));
    assert.deepEqual(result.rows, [{ id: 'owned' }]);
    assert.equal(result.coverage.status, 'exhausted');
    assert.equal(result.coverage.complete, true);
});

test('verified opaque feed identity is carried across pages and cannot drift into another feed', async () => {
    const feedId = '6ca61772-0000-2598-b377-10d9a20643c3';
    const fixture = initial([video('first'), token('NEXT')]);
    Object.assign(fixture.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer, { targetId: feedId });
    let calls = 0;
    const result = await collectContentSection(options([], {
        initialData: fixture, maxPages: 3,
        fetchContinuation: async () => {
            calls += 1;
            const data = next([video(calls === 1 ? 'second' : 'wrong'), token(`NEXT_${calls}`)]);
            data.onResponseReceivedActions[0].appendContinuationItemsAction.targetId = calls === 1 ? feedId : 'other-opaque-feed';
            return data;
        },
    }));
    assert.equal(calls, 2);
    assert.deepEqual(result.rows.map(row => row.id), ['first', 'second']);
    assert.equal(result.coverage.rowsSeen, 2);
    assert.equal(result.coverage.status, 'unsupported');
    assert.equal(result.coverage.selectedTabVerified, true);
    assert.equal(result.coverage.complete, false);
});
