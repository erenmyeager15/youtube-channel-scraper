import assert from 'node:assert/strict';
import test from 'node:test';
import { runYouTube, type RunServices, type RunSummary } from './runner.js';
import type { ContentSection } from './content-pagination.js';
import type { ChannelRecord, CommunityPostRecord, PlaylistRecord, VideoRecord } from './types.js';
import type { YouTubePage } from './youtube-http.js';

type ContentRecord = CommunityPostRecord | PlaylistRecord | VideoRecord;
type ChargeResult = Awaited<ReturnType<RunServices['saveChannel']>>;
type FixtureData = Record<string, any>;

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const CHANNEL = 'https://www.youtube.com/@owner';
const INITIAL = `${CHANNEL}/videos`;
const PUBLIC = 'https://www.youtube.com/channel/UC_OWNER';

function video(id: string, date: string | null = '2026-10-01', extra: FixtureData = {}): FixtureData {
    return { videoRenderer: {
        videoId: id,
        title: { simpleText: `Video ${id}` },
        publishedTimeText: date ? { simpleText: date } : undefined,
        viewCountText: { simpleText: '1.2K views' },
        lengthText: { simpleText: '0:45' },
        navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: `/watch?v=${id}` } } },
        ...extra,
    } };
}

const token = (value: string): FixtureData => ({ continuationItemRenderer: {
    continuationEndpoint: { continuationCommand: { token: value } },
} });

function tab(section: ContentSection, entries: FixtureData[], metadata: FixtureData = {}): FixtureData {
    return {
        metadata: { channelMetadataRenderer: {
            externalId: 'UC_OWNER', title: 'Owner channel',
            channelUrl: CHANNEL, vanityChannelUrl: CHANNEL,
            description: 'Public channel description', ...metadata,
        } },
        header: { c4TabbedHeaderRenderer: { subscriberCountText: { simpleText: '12K subscribers' } } },
        contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
            selected: true,
            endpoint: { commandMetadata: { webCommandMetadata: {
                url: `/channel/UC_OWNER/${section === 'community' ? 'posts' : section}`,
            } } },
            content: { richGridRenderer: { contents: entries } },
        } }] } },
    };
}

function continuation(entries: FixtureData[]): FixtureData {
    return { onResponseReceivedActions: [{ appendContinuationItemsAction: {
        targetId: 'browse-feed', continuationItems: entries,
    } }] };
}

function page(initialData: FixtureData, html = 'fixture document'): YouTubePage {
    return { initialData, html, finalUrl: INITIAL };
}

function post(id: string, text = 'Public channel update'): FixtureData {
    return { backstagePostThreadRenderer: {
        post: { backstagePostRenderer: {
            postId: id,
            authorEndpoint: { browseEndpoint: { browseId: 'UC_OWNER' } },
            contentText: { simpleText: text },
            publishedTimeText: { simpleText: '2026-10-01' },
            voteCount: { simpleText: '8' },
        } },
        replies: [{ backstagePostRenderer: {
            postId: 'PRIVATE_REPLY_ID', contentText: { simpleText: 'PRIVATE_COMMENTER_CONTENT' },
            authorText: { simpleText: 'PRIVATE_COMMENTER_IDENTITY' },
        } }],
    } };
}

function about(description = 'Public About description'): YouTubePage {
    return page({ channelAboutFullMetadataRenderer: {
        description: { simpleText: description }, country: { simpleText: 'India' },
        subscriberCountText: { simpleText: '12K subscribers' },
        canonicalChannelUrl: CHANNEL,
    } });
}

interface HarnessOptions {
    pages?: Record<string, YouTubePage | Error>;
    continuations?: Record<string, FixtureData | Error>;
    players?: Record<string, FixtureData | Error>;
    charges?: ChargeResult[];
    rowWriteError?: Error;
    channelWriteError?: Error;
    /** Simulate retries; each attempt must consume the same channel budget. */
    attempts?: Record<string, number>;
}

function harness(options: HarnessOptions = {}) {
    const requests: { kind: 'page' | 'continuation' | 'player'; key: string }[] = [];
    const channelSaveAttempts: ChannelRecord[] = [];
    const savedChannels: ChannelRecord[] = [];
    const chargedChannels: ChannelRecord[] = [];
    const savedRows: ContentRecord[] = [];
    const summaries: RunSummary[] = [];
    const events: string[] = [];
    const logs: string[] = [];
    const admit = (kind: 'page' | 'continuation' | 'player', key: string,
        budget: Parameters<RunServices['fetchPage']>[1]) => {
        for (let attempt = 0; attempt < (options.attempts?.[key] ?? 1); attempt += 1) {
            budget.take();
            requests.push({ kind, key });
            events.push(`${kind}:${key}`);
        }
    };
    const resolve = <T>(value: T | Error | undefined, kind: string, key: string): T => {
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`Unexpected fixture ${kind}: ${key}`);
        return value;
    };
    const services: RunServices = {
        now: () => NOW,
        fetchPage: async (url, budget) => {
            admit('page', url, budget);
            return resolve(options.pages?.[url], 'page', url);
        },
        fetchContinuation: async (value, _html, budget) => {
            admit('continuation', value, budget);
            return resolve(options.continuations?.[value], 'continuation', value);
        },
        fetchPlayer: async (id, _html, budget) => {
            admit('player', id, budget);
            return resolve(options.players?.[id], 'player', id);
        },
        saveChannel: async (record) => {
            channelSaveAttempts.push(structuredClone(record));
            events.push(`save-channel:${record.channelId}`);
            if (options.channelWriteError) throw options.channelWriteError;
            const charge = options.charges?.[channelSaveAttempts.length - 1]
                ?? { chargedCount: 1, eventChargeLimitReached: false };
            // Model Apify's atomic pushData(event): a rejected charge does not write a row.
            if (charge.chargedCount > 0 || !charge.eventChargeLimitReached) {
                savedChannels.push(structuredClone(record));
            }
            if (charge.chargedCount > 0) chargedChannels.push(structuredClone(record));
            return charge;
        },
        saveRows: async (records) => {
            events.push(`save-rows:${records.map((record) => record.recordType).join(',')}`);
            if (options.rowWriteError) throw options.rowWriteError;
            savedRows.push(...structuredClone(records));
        },
        saveSummary: async (summary) => {
            summaries.push(structuredClone(summary));
            events.push(`save-summary:${summary.status}`);
        },
        log: {
            info: (message) => { logs.push(message); }, warning: (message) => { logs.push(message); },
            error: (message) => { logs.push(message); }, debug: (message) => { logs.push(message); },
        },
    };
    return { services, requests, channelSaveAttempts, savedChannels, chargedChannels, savedRows, summaries, events, logs };
}

test('default collection saves one channel and one video with no extra page request', async () => {
    const fixture = harness({ pages: { [INITIAL]: page(tab('videos', [video('first'), video('overflow'), token('NEXT')])) } });
    const summary = await runYouTube({ channelUrls: ['@owner'] }, fixture.services);
    assert.equal(fixture.savedChannels.length, 1);
    assert.equal(fixture.savedRows.length, 1);
    assert.equal((fixture.savedRows[0] as VideoRecord).videoId, 'first');
    assert.deepEqual(fixture.requests, [{ kind: 'page', key: INITIAL }]);
    assert.equal(summary.limits.maxPagesPerSection, 1);
    assert.equal(summary.limits.maxRequestsPerChannel, 30);
    assert.equal(summary.savedChannelCount, 1);
    assert.equal(summary.savedVideoCount, 1);
    assert.equal(summary.channels[0].sections.videos?.status, 'row-limit');
    assert.equal(summary.channels[0].sections.videos?.rowsSaved, 1);
    assert.equal(summary.complete, false);
    assert.equal(summary.status, 'succeeded');
    assert.equal(fixture.summaries.length, 1);
});

test('detailed failure summaries identify stages with fixed codes and preserve core rows without raw errors', async () => {
    const watchUrl = 'https://www.youtube.com/watch?v=owned';
    for (const player of [true, false]) {
        const privateError = Object.assign(new Error('PRIVATE_TOKEN PRIVATE_PROXY_URL PRIVATE_RESPONSE'), {
            reason: player ? 'player-metadata-missing' : 'UNAPPROVED_PRIVATE_REASON',
        });
        const fixture = harness({
            pages: {
                [INITIAL]: page(tab('videos', [video('owned', '1d ago')])),
                [`${CHANNEL}/about`]: about(),
                [watchUrl]: player ? { ...page({}), finalUrl: watchUrl } : privateError,
            },
            players: { owned: privateError },
        });
        const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed' }, fixture.services);
        assert.equal(summary.detailedRequestFailureCount, 1);
        assert.equal(summary.channels[0].detailedRequestsFailed, 1);
        assert.deepEqual(summary.channels[0].detailedFailures, [{
            stage: player ? 'player' : 'video-page',
            category: player ? 'player-metadata-missing' : 'source-unavailable',
        }]);
        assert.equal(fixture.savedRows.length, 1);
        assert.equal((fixture.savedRows[0] as VideoRecord).videoId, 'owned');
        assert.equal(summary.complete, false);
        assert.doesNotMatch(JSON.stringify({ summary, logs: fixture.logs, rows: fixture.savedRows }), /PRIVATE_/);
    }
});

test('identified watch calendar dates survive a missing player response with safe status diagnostics', async () => {
    const watchUrl = 'https://www.youtube.com/watch?v=owned';
    const fixture = harness({ pages: {
        [INITIAL]: page(tab('videos', [video('owned', '1d ago')])),
        [`${CHANNEL}/about`]: about(),
        [watchUrl]: { html: 'public page', finalUrl: watchUrl, initialData: {
            currentVideoEndpoint: { watchEndpoint: { videoId: 'owned' } },
            contents: { twoColumnWatchNextResults: { results: { results: { contents: [
                { videoPrimaryInfoRenderer: { dateText: { simpleText: 'Sep 30, 2026' } } },
            ] } } } },
        } },
    }, players: { owned: Object.assign(new Error('PRIVATE_RESPONSE'), {
        reason: 'player-metadata-missing', playerStatus: 'LOGIN_REQUIRED', sourceBody: 'PRIVATE_TOKEN',
    }) } });
    const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed',
        publishedAfter: '2026-09-30', publishedBefore: '2026-09-30' }, fixture.services);
    const row = fixture.savedRows[0] as VideoRecord;
    assert.equal(row.publishedDate, '2026-09-30');
    assert.equal(row.sourceDateText, '1d ago');
    assert.equal(row.publishedAtPrecision, 'day');
    assert.equal(row.publicationWindowMatch, 'in-window');
    assert.equal(row.category, null);
    assert.deepEqual(row.tags, []);
    assert.deepEqual(summary.channels[0].detailedFailures, [{ stage: 'player',
        category: 'player-metadata-missing', playerStatus: 'LOGIN_REQUIRED' }]);
    assert.equal(summary.channels[0].requestsUsed, 4);
    assert.equal(summary.complete, false);
    assert.doesNotMatch(JSON.stringify({ summary, rows: fixture.savedRows, logs: fixture.logs }), /PRIVATE_/);
});

test('the one-page default exposes an advertised continuation without following it', async () => {
    const fixture = harness({ pages: { [INITIAL]: page(tab('videos', [video('first'), token('NEXT')])) } });
    const summary = await runYouTube({ channelUrls: ['@owner'], maxVideosPerChannel: 3 }, fixture.services);
    assert.equal(fixture.requests.length, 1);
    assert.equal(summary.channels[0].sections.videos?.status, 'page-limit');
    assert.equal(summary.channels[0].sections.videos?.morePagesAvailable, true);
    assert.equal(summary.channels[0].sections.videos?.pagesFetched, 1);
    assert.equal(summary.complete, false);
});

test('a channel that fills the charge cap finishes its bounded selected content before the next channel', async () => {
    const fixture = harness({
        charges: [{ chargedCount: 1, eventChargeLimitReached: true }],
        pages: {
            [INITIAL]: page(tab('videos', [video('regular')])),
            [`${PUBLIC}/shorts`]: page(tab('shorts', [{ reelItemRenderer: {
                videoId: 'short', headline: { simpleText: 'Public Short' },
            } }])),
            [`${PUBLIC}/streams`]: page(tab('streams', [video('stream', 'Streamed 1 day ago')])),
            [`${PUBLIC}/playlists`]: page(tab('playlists', [{ gridPlaylistRenderer: {
                playlistId: 'PL_OWNER', title: { simpleText: 'Owner playlist' }, videoCountText: { simpleText: '3 videos' },
            } }])),
            [`${PUBLIC}/posts`]: page(tab('community', [post('owned-post')])),
        },
    });
    const summary = await runYouTube({
        channelUrls: ['@owner', '@next'], includeShorts: true, includeLiveStreams: true,
        includePlaylists: true, includeCommunityPosts: true,
    }, fixture.services);
    assert.equal(fixture.channelSaveAttempts.length, 1);
    assert.equal(fixture.chargedChannels.length, 1);
    assert.equal(fixture.savedChannels.length, 1);
    assert.equal(fixture.savedRows.length, 5);
    assert.equal(summary.savedChannelCount, 1);
    assert.equal(summary.savedVideoCount, 3);
    assert.equal(summary.spendingLimitReached, true);
    assert.equal(summary.channels.length, 1);
    assert.equal(summary.channels[0].requestsUsed, 5);
    assert.ok(fixture.requests.every((request) => !request.key.includes('@next')));
    assert.ok(fixture.events.indexOf('save-channel:UC_OWNER') < fixture.events.indexOf(`page:${PUBLIC}/shorts`));
    for (const section of ['videos', 'shorts', 'streams', 'playlists', 'community'] as const) {
        assert.equal(summary.channels[0].sections[section]?.rowsSaved, 1);
    }
});

test('a rejected atomic channel charge saves no rows and fetches no additional content', async () => {
    const fixture = harness({
        charges: [{ chargedCount: 0, eventChargeLimitReached: true }],
        pages: { [INITIAL]: page(tab('videos', [video('first'), token('NEXT')])) },
    });
    const summary = await runYouTube({ channelUrls: ['@owner', '@next'], maxPagesPerSection: 5,
        includeShorts: true, includeCommunityPosts: true }, fixture.services);
    assert.equal(fixture.channelSaveAttempts.length, 1);
    assert.equal(fixture.chargedChannels.length, 0);
    assert.equal(fixture.savedChannels.length, 0);
    assert.equal(fixture.savedRows.length, 0);
    assert.deepEqual(fixture.requests, [{ kind: 'page', key: INITIAL }]);
    assert.equal(summary.savedChannelCount, 0);
    assert.equal(summary.savedVideoCount, 0);
    assert.equal(summary.channels[0].status, 'charge-limit');
    assert.equal(summary.spendingLimitReached, true);
    assert.equal(summary.complete, false);
});

test('date-excluded initial pages continue to later relevant and unknown rows with honest summaries', async () => {
    const fixture = harness({
        pages: { [INITIAL]: page(tab('videos', [video('old', '2026-09-01'), token('NEXT')])) },
        continuations: { NEXT: continuation([
            video('known', '2026-10-01'), video('unknown', null), video('also-old', '2026-09-15'),
        ]) },
    });
    const summary = await runYouTube({ channelUrls: ['@owner'], maxPagesPerSection: 2,
        maxVideosPerChannel: 3, publishedAfter: '2026-10-01', publishedBefore: '2026-10-02' }, fixture.services);
    assert.deepEqual(fixture.savedRows.map((row) => (row as VideoRecord).videoId), ['known', 'unknown']);
    assert.equal((fixture.savedRows[0] as VideoRecord).publicationWindowMatch, 'in-window');
    const unknown = fixture.savedRows[1] as VideoRecord;
    assert.equal(unknown.publicationWindowMatch, 'uncertain');
    assert.equal(unknown.publishedAt, null);
    assert.equal(unknown.publishedAtEarliest, null);
    assert.deepEqual(fixture.requests, [{ kind: 'page', key: INITIAL }, { kind: 'continuation', key: 'NEXT' }]);
    const coverage = summary.channels[0].sections.videos!;
    assert.equal(coverage.rowsSeen, 4);
    assert.equal(coverage.filteredRows, 2);
    assert.equal(coverage.uncertainRows, 1);
    assert.equal(coverage.rowsSelected, 2);
    assert.equal(coverage.rowsSaved, 2);
    assert.equal(coverage.pagesFetched, 2);
    assert.equal(coverage.status, 'exhausted');
    assert.equal(coverage.complete, false);
    assert.equal(coverage.dateFilterApplied, true);
    assert.equal(summary.complete, false);
    assert.deepEqual(summary.publicationWindow, {
        publishedAfter: '2026-10-01T00:00:00.000Z', publishedBefore: '2026-10-02T23:59:59.999Z',
    });
});

test('exact player publication metadata can exclude a row initially retained for relative-date uncertainty', async () => {
    const fixture = harness({
        pages: {
            [INITIAL]: page(tab('videos', [video('relative', '1 day ago')])),
            [`${CHANNEL}/about`]: about(),
            'https://www.youtube.com/watch?v=relative': page({}),
        },
        players: { relative: {
            videoDetails: { videoId: 'relative', title: 'Verified publication', keywords: ['research'], lengthSeconds: '45' },
            microformat: { playerMicroformatRenderer: { publishDate: '2026-09-01', category: 'Science' } },
        } },
    });
    const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed',
        publishedAfter: '2026-10-02', publishedBefore: '2026-10-02' }, fixture.services);
    assert.equal(fixture.savedChannels.length, 1);
    assert.equal(fixture.savedRows.length, 0);
    assert.equal(fixture.requests.filter((request) => request.kind === 'player').length, 1);
    assert.equal(summary.channels[0].requestsUsed, 4);
    assert.equal(summary.savedVideoCount, 0);
    assert.equal(summary.channels[0].sections.videos?.filteredRows, 1);
    assert.equal(summary.channels[0].sections.videos?.uncertainRows, 0);
    assert.equal(summary.channels[0].sections.videos?.rowsSaved, 0);
    assert.equal(summary.complete, true);
});

test('a calendar day with category and tags still requests the missing exact timestamp', async () => {
    const watchUrl = 'https://www.youtube.com/watch?v=owned';
    const dayPlayer = { videoDetails: { videoId: 'owned', keywords: ['research'] },
        microformat: { playerMicroformatRenderer: { category: 'Science', publishDate: '2026-10-01' } } };
    const fixture = harness({ pages: {
        [INITIAL]: page(tab('videos', [video('owned', '1d ago')])),
        [`${CHANNEL}/about`]: about(),
        [watchUrl]: { ...page({}, `<script>var ytInitialPlayerResponse = ${JSON.stringify(dayPlayer)};</script>`), finalUrl: watchUrl },
    }, players: { owned: { ...dayPlayer,
        microformat: { playerMicroformatRenderer: { category: 'Science', publishDate: '2026-10-01T11:12:13Z' } } },
    } });
    const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed' }, fixture.services);
    assert.equal(fixture.requests.filter(request => request.kind === 'player').length, 1);
    assert.equal((fixture.savedRows[0] as VideoRecord).publishedAtPrecision, 'exact');
    assert.equal((fixture.savedRows[0] as VideoRecord).publishedAt, '2026-10-01T11:12:13.000Z');
    assert.equal(summary.detailedRequestFailureCount, 0);
});

test('a confirmed source automation check retains watch data but never claims complete detailed coverage', async () => {
    const watchUrl = 'https://www.youtube.com/watch?v=owned';
    const fixture = harness({ pages: {
        [INITIAL]: page(tab('videos', [video('owned', '1d ago')])),
        [`${CHANNEL}/about`]: about(),
        [watchUrl]: { ...page({ currentVideoEndpoint: { watchEndpoint: { videoId: 'owned' } } }), finalUrl: watchUrl },
    }, players: { owned: Object.assign(new Error('PRIVATE_CHALLENGE_TEXT'), {
        reason: 'source-automation-check', playerStatus: 'LOGIN_REQUIRED',
    }) } });
    const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed' }, fixture.services);
    assert.equal(fixture.savedRows.length, 1);
    assert.equal(summary.complete, false);
    assert.deepEqual(summary.channels[0].detailedFailures, [{ stage: 'player',
        category: 'source-automation-check', playerStatus: 'LOGIN_REQUIRED' }]);
    assert.doesNotMatch(JSON.stringify({ summary, rows: fixture.savedRows, logs: fixture.logs }), /PRIVATE_/);
});

test('the shared request budget includes retries and retains collected rows when continuation is blocked', async () => {
    const fixture = harness({
        pages: { [INITIAL]: page(tab('videos', [video('safe'), token('NEXT')])) },
        attempts: { [INITIAL]: 2 },
    });
    const summary = await runYouTube({ channelUrls: ['@owner'], maxVideosPerChannel: 3,
        maxPagesPerSection: 2, maxRequestsPerChannel: 2, includeShorts: true }, fixture.services);
    assert.equal(fixture.savedRows.length, 1);
    assert.equal(summary.channels[0].requestsUsed, 2);
    assert.equal(fixture.requests.length, 2);
    assert.ok(fixture.requests.every((request) => request.kind === 'page' && request.key === INITIAL));
    assert.equal(summary.channels[0].sections.videos?.status, 'request-limit');
    assert.equal(summary.channels[0].sections.videos?.pagesFetched, 1);
    assert.equal(summary.channels[0].sections.videos?.rowsSaved, 1);
    assert.equal(summary.channels[0].sections.shorts?.status, 'request-limit');
    assert.equal(summary.channels[0].sections.shorts?.rowsSaved, 0);
    assert.equal(summary.complete, false);
    assert.equal(summary.status, 'succeeded');
});

test('unsupported optional tabs keep existing rows and expose partial coverage', async () => {
    const fixture = harness({ pages: {
        [INITIAL]: page(tab('videos', [video('safe')])),
        [`${PUBLIC}/shorts`]: page({ arbitrary: video('unverified-suggestion') }),
    } });
    const summary = await runYouTube({ channelUrls: ['@owner'], includeShorts: true }, fixture.services);
    assert.deepEqual(fixture.savedRows.map((row) => (row as VideoRecord).videoId), ['safe']);
    assert.equal(summary.channels[0].sections.shorts?.status, 'unsupported');
    assert.equal(summary.channels[0].sections.shorts?.selectedTabVerified, false);
    assert.equal(summary.channels[0].sections.shorts?.morePagesAvailable, null);
    assert.equal(summary.channels[0].sections.shorts?.complete, false);
    assert.equal(summary.complete, false);
});

test('dataset content-write failure throws and persists failed RUN-SUMMARY without successful row counts', async () => {
    const fixture = harness({
        pages: { [INITIAL]: page(tab('videos', [video('first')])) },
        rowWriteError: new Error('PRIVATE_STORAGE_FAILURE'),
    });
    await assert.rejects(runYouTube({ channelUrls: ['@owner'] }, fixture.services), /Video dataset write failed/);
    assert.equal(fixture.savedRows.length, 0);
    assert.equal(fixture.summaries.length, 1);
    const summary = fixture.summaries[0];
    assert.equal(summary.status, 'failed');
    assert.equal(summary.complete, false);
    assert.equal(summary.savedChannelCount, 1);
    assert.equal(summary.savedVideoCount, 0);
    assert.equal(summary.failedRequestCount, 1);
    assert.equal(summary.channels[0].status, 'failed');
    assert.equal(summary.channels[0].sections.videos?.rowsSaved, 0);
    assert.equal(summary.channels[0].sections.videos?.complete, false);
    assert.equal(fixture.events.at(-1), 'save-summary:failed');
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_STORAGE_FAILURE/);
});

test('dataset channel-write failure saves a failed summary and cannot report a charged saved channel', async () => {
    const fixture = harness({
        pages: { [INITIAL]: page(tab('videos', [video('first')])) },
        channelWriteError: new Error('PRIVATE_CHANNEL_STORAGE_FAILURE'),
    });
    await assert.rejects(runYouTube({ channelUrls: ['@owner'] }, fixture.services), /Channel dataset write failed/);
    assert.equal(fixture.savedChannels.length, 0);
    assert.equal(fixture.chargedChannels.length, 0);
    assert.equal(fixture.savedRows.length, 0);
    assert.equal(fixture.summaries[0].status, 'failed');
    assert.equal(fixture.summaries[0].savedChannelCount, 0);
    assert.equal(fixture.summaries[0].complete, false);
});

test('different aliases of one channel are charged and written only once', async () => {
    const aliasUrl = 'https://www.youtube.com/c/owner';
    const fixture = harness({ pages: {
        [INITIAL]: page(tab('videos', [video('owned')])),
        [`${aliasUrl}/videos`]: page(tab('videos', [video('owned')])),
    } });
    const summary = await runYouTube({ channelUrls: ['@owner', aliasUrl] }, fixture.services);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.channelSaveAttempts.length, 1);
    assert.equal(fixture.chargedChannels.length, 1);
    assert.equal(fixture.savedRows.length, 1);
    assert.equal(summary.savedChannelCount, 1);
    assert.deepEqual(summary.channels.map((channel) => channel.status), ['saved', 'duplicate']);
    assert.equal(summary.complete, true);
});

test('content scoping and privacy survive the complete fixture run', async () => {
    const initial = tab('videos', [video('owned')], {
        description: 'Email creator@example.com or call +91 98765 43210',
    });
    initial.engagementPanels = [video('UNRELATED_PANEL_VIDEO')];
    initial.contents.twoColumnBrowseResultsRenderer.tabs.push({ tabRenderer: {
        selected: false,
        endpoint: { commandMetadata: { webCommandMetadata: { url: '/channel/UC_OWNER/shorts' } } },
        content: { richGridRenderer: { contents: [video('UNSELECTED_TAB_VIDEO')] } },
    } });
    const fixture = harness({ pages: {
        [INITIAL]: page(initial, 'PRIVATE_RAW_RESPONSE_BODY'),
        [`${CHANNEL}/about`]: about('Email about@example.com or call +91 98765 43210'),
        'https://www.youtube.com/watch?v=owned': page({
            commentsHeaderRenderer: { countText: { simpleText: '12 comments' } },
            commentRenderer: { authorText: { simpleText: 'PRIVATE_COMMENTER_IDENTITY' },
                contentText: { simpleText: 'PRIVATE_COMMENTER_CONTENT' } },
        }, '<meta itemprop="datePublished" content="2026-10-01">'
            + '<meta itemprop="genre" content="Science">'
            + '<meta name="keywords" content="research">'
            + '<meta name="description" content="Email video@example.com or call +91 98765 43210">'),
        [`${PUBLIC}/posts`]: page(tab('community', [post('owned-post', 'Email post@example.com or call +91 98765 43210')])),
    } });
    const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed',
        includeCommunityPosts: true }, fixture.services);
    assert.equal(summary.savedChannelCount, 1);
    assert.equal(summary.savedVideoCount, 1);
    const savedVideo = fixture.savedRows.find((row): row is VideoRecord => row.recordType === 'video')!;
    assert.equal(savedVideo.videoId, 'owned');
    assert.equal(savedVideo.isShorts, false, 'A 45-second ordinary video remains an ordinary video.');
    assert.equal(savedVideo.commentCountNumber, 12);
    assert.equal(savedVideo.publishedAtPrecision, 'day');
    assert.match(savedVideo.videoDescription!, /\[redacted\]/);
    assert.match(fixture.savedChannels[0].channelDescription!, /\[redacted\]/);
    assert.equal(fixture.savedRows.filter((row) => row.recordType === 'community_post').length, 1);
    const exposed = JSON.stringify({ channels: fixture.savedChannels, rows: fixture.savedRows,
        summary, logs: fixture.logs });
    assert.doesNotMatch(exposed, /(?:creator|about|video|post)@example\.com|98765|PRIVATE_COMMENTER|PRIVATE_REPLY|PRIVATE_RAW_RESPONSE|UNRELATED_PANEL|UNSELECTED_TAB/);
});

test('identical pure actor input works for admitted free and paid channel-save responses without identity gating', async () => {
    const input = { channelUrls: ['@owner'] };
    for (const chargedCount of [0, 1]) {
        const fixture = harness({
            pages: { [INITIAL]: page(tab('videos', [video('public')])) },
            charges: [{ chargedCount, eventChargeLimitReached: false }],
        });
        const summary = await runYouTube(input, fixture.services);
        assert.equal(summary.status, 'succeeded');
        assert.equal(summary.savedChannelCount, 1);
        assert.equal(summary.savedVideoCount, 1);
        assert.equal(summary.complete, true);
        assert.equal(fixture.savedChannels.length, 1);
        assert.equal(fixture.savedRows.length, 1);
        assert.equal(fixture.chargedChannels.length, chargedCount);
    }
});

test('a player response for another video retains the source row and reports detail uncertainty', async () => {
    const fixture = harness({
        pages: {
            [INITIAL]: page(tab('videos', [video('relative', '1 day ago')])),
            [`${CHANNEL}/about`]: about(),
            'https://www.youtube.com/watch?v=relative': page({}),
        },
        players: { relative: {
            videoDetails: { videoId: 'FOREIGN_VIDEO_ID', title: 'FOREIGN_PLAYER_TITLE', keywords: ['foreign'] },
            microformat: { playerMicroformatRenderer: { publishDate: '2026-09-01', category: 'Foreign category' } },
        } },
    });
    const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed',
        publishedAfter: '2026-10-02', publishedBefore: '2026-10-02' }, fixture.services);
    assert.equal(fixture.savedRows.length, 1);
    const saved = fixture.savedRows[0] as VideoRecord;
    assert.equal(saved.videoId, 'relative');
    assert.equal(saved.videoTitle, 'Video relative');
    assert.equal(saved.publishedDate, '1 day ago');
    assert.equal(saved.sourceDateText, '1 day ago');
    assert.equal(saved.publishedAt, null);
    assert.equal(saved.publishedAtPrecision, 'relative');
    assert.equal(saved.publicationWindowMatch, 'uncertain');
    assert.equal(summary.savedVideoCount, 1);
    assert.ok(summary.detailedRequestFailureCount > 0);
    assert.ok(summary.channels[0].detailedRequestsFailed > 0);
    assert.equal(summary.channels[0].sections.videos?.uncertainRows, 1);
    assert.equal(summary.channels[0].sections.videos?.filteredRows, 0);
    assert.equal(summary.complete, false);
    assert.doesNotMatch(JSON.stringify({ rows: fixture.savedRows, summary }), /FOREIGN_VIDEO_ID|FOREIGN_PLAYER_TITLE|Foreign category/);
});

test('an About page identifying another owner cannot supply channel fields or redirect content feeds', async () => {
    const foreignAbout = about('FOREIGN_ABOUT_DESCRIPTION');
    foreignAbout.initialData.metadata = { channelMetadataRenderer: {
        externalId: 'UC_FOREIGN', title: 'FOREIGN_ABOUT_TITLE',
    } };
    foreignAbout.initialData.channelAboutFullMetadataRenderer.country = { simpleText: 'FOREIGN_ABOUT_COUNTRY' };
    foreignAbout.initialData.channelAboutFullMetadataRenderer.canonicalChannelUrl = 'https://www.youtube.com/channel/UC_FOREIGN';
    foreignAbout.initialData.channelAboutFullMetadataRenderer.viewCountText = { simpleText: '999 views' };
    const fixture = harness({ pages: {
        [INITIAL]: page(tab('videos', [video('owned')])),
        [`${CHANNEL}/about`]: foreignAbout,
        [`${PUBLIC}/shorts`]: page(tab('shorts', [])),
    } });
    const summary = await runYouTube({ channelUrls: ['@owner'], mode: 'detailed',
        maxDetailedVideosPerChannel: 0, includeShorts: true }, fixture.services);
    assert.equal(fixture.savedChannels.length, 1);
    const saved = fixture.savedChannels[0];
    assert.equal(saved.channelId, 'UC_OWNER');
    assert.equal(saved.channelUrl, CHANNEL);
    assert.equal(saved.canonicalChannelUrl, CHANNEL);
    assert.equal(saved.channelDescription, 'Public channel description');
    assert.equal(saved.country, null);
    assert.equal(saved.totalViews, null);
    assert.equal(saved.videosUrl, `${PUBLIC}/videos`);
    assert.equal(saved.shortsUrl, `${PUBLIC}/shorts`);
    assert.ok(fixture.requests.some((request) => request.key === `${PUBLIC}/shorts`));
    assert.ok(fixture.requests.every((request) => !request.key.includes('UC_FOREIGN')));
    assert.ok(summary.detailedRequestFailureCount > 0);
    assert.equal(summary.savedVideoCount, 1);
    assert.equal(summary.complete, false);
    assert.doesNotMatch(JSON.stringify({ rows: fixture.savedRows, channels: fixture.savedChannels, summary }), /FOREIGN_ABOUT|UC_FOREIGN/);
});

test('an initial page with a different explicit channel ID fails before any atomic charge or dataset write', async () => {
    const requested = 'https://www.youtube.com/channel/UC_EXPECTED';
    const fixture = harness({ pages: {
        [`${requested}/videos`]: page(tab('videos', [video('foreign')], {
            externalId: 'UC_FOREIGN', channelUrl: 'https://www.youtube.com/channel/UC_FOREIGN',
        })),
    } });
    await assert.rejects(runYouTube({ channelUrls: [requested], includeShorts: true }, fixture.services),
        /No YouTube channel rows were saved/);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.channelSaveAttempts.length, 0);
    assert.equal(fixture.chargedChannels.length, 0);
    assert.equal(fixture.savedChannels.length, 0);
    assert.equal(fixture.savedRows.length, 0);
    assert.equal(fixture.summaries.length, 1);
    const summary = fixture.summaries[0];
    assert.equal(summary.status, 'failed');
    assert.equal(summary.complete, false);
    assert.equal(summary.savedChannelCount, 0);
    assert.equal(summary.savedVideoCount, 0);
    assert.equal(summary.failedRequestCount, 1);
    assert.equal(summary.channels[0].status, 'failed');
    assert.equal(summary.channels[0].requestsUsed, 1);
});
