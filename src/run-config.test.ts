import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeActorInput } from './run-config.js';
import type { ActorInput } from './types.js';

function normalize(extra: Record<string, unknown> = {}) {
    return normalizeActorInput({ channelUrls: ['@mkbhd'], ...extra } as ActorInput);
}

test('new collection controls preserve all existing normalized defaults', () => {
    assert.deepEqual(normalize(), {
        channelUrls: ['https://www.youtube.com/@mkbhd'],
        searchKeywords: [],
        mode: 'fast',
        maxChannels: 1,
        maxVideosPerChannel: 1,
        maxDetailedVideosPerChannel: 1,
        includeShorts: false,
        maxShortsPerChannel: 10,
        includeLiveStreams: false,
        maxLiveStreamsPerChannel: 10,
        includePlaylists: false,
        maxPlaylistsPerChannel: 10,
        includeCommunityPosts: false,
        maxCommunityPostsPerChannel: 10,
        publishedAfter: null,
        publishedBefore: null,
        maxPagesPerSection: 1,
        maxRequestsPerChannel: 30,
        proxyOptions: undefined,
        metadataProxyFallback: false,
        maxRequestsPerCrawl: 50,
    });
    assert.equal(normalize({ mode: 'detailed' }).maxRequestsPerCrawl, 10);
    assert.equal(normalize({ searchKeywords: ['public research'] }).maxRequestsPerCrawl, 51);
});

test('optional blank publication fields normalize to null', () => {
    const input = normalize({ publishedAfter: ' ', publishedBefore: '' });
    assert.equal(input.publishedAfter, null);
    assert.equal(input.publishedBefore, null);
    assert.equal(input.maxPagesPerSection, 1);
    assert.equal(input.maxRequestsPerChannel, 30);
});

test('metadata-only proxy is explicit opt-in and cannot silently combine with full-page proxying', () => {
    assert.equal(normalize().metadataProxyFallback, false);
    assert.equal(normalize({ metadataProxyFallback: true }).metadataProxyFallback, true);
    for (const value of ['true', 1, null, {}]) {
        assert.throws(() => normalize({ metadataProxyFallback: value }), /metadataProxyFallback/);
    }
    assert.throws(() => normalize({ metadataProxyFallback: true,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } }), /do not combine/);
    assert.equal(normalize({ metadataProxyFallback: true,
        proxyConfiguration: { useApifyProxy: false } }).proxyOptions, undefined);
    const schema = JSON.parse(readFileSync(new URL('../INPUT_SCHEMA.json', import.meta.url), 'utf8'));
    assert.equal(schema.properties.metadataProxyFallback.default, false);
});

test('date inputs become canonical inclusive UTC boundaries', () => {
    const dates = normalize({ publishedAfter: '2026-10-01', publishedBefore: '2026-10-02' });
    assert.equal(dates.publishedAfter, '2026-10-01T00:00:00.000Z');
    assert.equal(dates.publishedBefore, '2026-10-02T23:59:59.999Z');
    const timestamps = normalize({
        publishedAfter: '2026-10-01T05:30:00+05:30', publishedBefore: '2026-10-02T00:00:00Z',
    });
    assert.equal(timestamps.publishedAfter, '2026-10-01T00:00:00.000Z');
    assert.equal(timestamps.publishedBefore, '2026-10-02T00:00:00.000Z');
});

test('bad, ambiguous and reversed date windows fail input validation', () => {
    for (const extra of [
        { publishedAfter: '2026-02-30' },
        { publishedBefore: '2026-10-02T12:00:00' },
        { publishedAfter: '10/01/2026' },
        { publishedBefore: 0 },
        { publishedAfter: '2026-10-03', publishedBefore: '2026-10-02' },
    ]) assert.throws(() => normalize(extra), /publishedAfter|publishedBefore/);
});

test('page and per-channel request controls accept only bounded integers', () => {
    assert.equal(normalize({ maxPagesPerSection: 1, maxRequestsPerChannel: 1 }).maxPagesPerSection, 1);
    const maximums = normalize({ maxPagesPerSection: 5, maxRequestsPerChannel: 50 });
    assert.equal(maximums.maxPagesPerSection, 5);
    assert.equal(maximums.maxRequestsPerChannel, 50);
    for (const invalid of [0, -1, 6, 1.5, '2', '', false, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => normalize({ maxPagesPerSection: invalid }), /maxPagesPerSection/);
    }
    for (const invalid of [0, -1, 51, 1.5, '30', '', false, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => normalize({ maxRequestsPerChannel: invalid }), /maxRequestsPerChannel/);
    }
});

test('schema controls match normalized defaults, caps and optional date semantics', () => {
    const schema = JSON.parse(readFileSync(new URL('../INPUT_SCHEMA.json', import.meta.url), 'utf8'));
    assert.equal(schema.properties.maxPagesPerSection.default, 1);
    assert.equal(schema.properties.maxPagesPerSection.minimum, 1);
    assert.equal(schema.properties.maxPagesPerSection.maximum, 5);
    assert.equal(schema.properties.maxRequestsPerChannel.default, 30);
    assert.equal(schema.properties.maxRequestsPerChannel.minimum, 1);
    assert.equal(schema.properties.maxRequestsPerChannel.maximum, 50);
    for (const field of ['publishedAfter', 'publishedBefore']) {
        assert.equal(schema.properties[field].type, 'string');
        assert.equal(schema.properties[field].format, undefined);
        assert.ok(!schema.required.includes(field));
        assert.match(schema.properties[field].description, /inclusive/);
        assert.match(schema.properties[field].description, /timezone/);
        assert.match(schema.properties[field].description, /uncertainty/);
    }
    assert.equal(schema.properties.mode.default, 'fast');
    assert.equal(schema.properties.maxVideosPerChannel.default, 1);
    assert.equal(schema.properties.maxDetailedVideosPerChannel.default, 1);
    assert.equal(schema.properties.proxyConfiguration.default.useApifyProxy, false);
});
