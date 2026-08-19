import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const readText = (path) => fs.readFileSync(new URL(path, root), 'utf8');

const {
  MAX_CHANNELS_PER_RUN,
  MAX_SEARCH_KEYWORDS,
  buildProxyConfigurationOptions,
  normalizeActorInput,
  normalizeYouTubeChannelUrl,
} = await import('../dist/run-config.js');
const {
  classifyYouTubeDocument,
  detectShorts,
  formatDuration,
  parseCompactCount,
  parseDurationToSeconds,
  redactContactInfo,
} = await import('../dist/youtube-utils.js');
const {
  extractChannelMetadata,
  extractInitialData,
  extractSearchChannelUrls,
  extractVideos,
} = await import('../dist/youtube-http.js');

const actor = readJson('.actor/actor.json');
const schema = readJson('INPUT_SCHEMA.json');

assert.equal(actor.pricingInfo?.pricingModel, 'PAY_PER_EVENT');
assert.equal(actor.pricingInfo.pricingPerEvent.actorChargeEvents['channel-scraped'].eventPriceUsd, 0.003);
assert.equal(actor.pricingInfo.pricingPerEvent.actorChargeEvents['channel-scraped'].isPrimaryEvent, true);
assert.equal(actor.pricingInfo.pricingPerEvent.actorChargeEvents['apify-actor-start'].eventPriceUsd, 0.00005);
assert.equal(actor.defaultRunOptions.memoryMbytes, 256);
assert.equal(actor.minMemoryMbytes, 256);
assert.equal(actor.maxMemoryMbytes, 1024);
assert.equal(actor.defaultRunOptions.timeoutSecs, 300);
assert.equal(schema.properties.channelUrls.maxItems, MAX_CHANNELS_PER_RUN);
assert.equal(schema.properties.searchKeywords.maxItems, MAX_SEARCH_KEYWORDS);

assert.equal(normalizeYouTubeChannelUrl('@mkbhd'), 'https://www.youtube.com/@mkbhd');
assert.equal(
  normalizeYouTubeChannelUrl('youtube.com/@mkbhd/videos?view=0'),
  'https://www.youtube.com/@mkbhd',
);
assert.equal(
  normalizeYouTubeChannelUrl('https://m.youtube.com/channel/UC123/featured'),
  'https://www.youtube.com/channel/UC123',
);
assert.throws(() => normalizeYouTubeChannelUrl('mkbhd'), /full channel URL or an @handle/i);
assert.throws(() => normalizeYouTubeChannelUrl('https://example.com/@mkbhd'), /only youtube\.com/i);
assert.throws(() => normalizeYouTubeChannelUrl('https://youtube.com/watch?v=abc'), /unsupported/i);

const normalized = normalizeActorInput({
  channelUrls: ['@mkbhd', 'https://www.youtube.com/@mkbhd/videos'],
  searchKeywords: ['technology', ' technology '],
  maxChannels: 3,
  maxVideosPerChannel: 5,
  proxyConfiguration: { useApifyProxy: false },
});
assert.deepEqual(normalized.channelUrls, ['https://www.youtube.com/@mkbhd']);
assert.deepEqual(normalized.searchKeywords, ['technology']);
assert.equal(normalized.maxRequestsPerCrawl, MAX_CHANNELS_PER_RUN + 1);
assert.equal(normalized.proxyOptions, undefined);
assert.throws(() => normalizeActorInput({ channelUrls: ['@mkbhd'], maxChannels: 0 }), /maxChannels/i);
assert.throws(
  () => normalizeActorInput({ channelUrls: ['@mkbhd'], includeShorts: 'false' }),
  /includeShorts must be a boolean/i,
);
assert.throws(
  () => normalizeActorInput({ channelUrls: Array.from({ length: MAX_CHANNELS_PER_RUN + 1 }, (_, index) => `@test${index}`) }),
  /at most 50/i,
);

assert.equal(buildProxyConfigurationOptions(undefined), undefined);
assert.equal(buildProxyConfigurationOptions({ useApifyProxy: false }), undefined);
assert.deepEqual(
  buildProxyConfigurationOptions({ useApifyProxy: false, proxyUrls: [' http://proxy.test:8000 ', 'http://proxy.test:8000'] }),
  { proxyUrls: ['http://proxy.test:8000'] },
);
assert.deepEqual(
  buildProxyConfigurationOptions({ apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'us' }),
  { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'US' },
);
assert.throws(
  () => buildProxyConfigurationOptions({ useApifyProxy: true, proxyUrls: ['http://proxy.test:8000'] }),
  /cannot combine/i,
);
assert.throws(
  () => buildProxyConfigurationOptions({ apifyProxyCountry: 'usa' }),
  /two-letter country code/i,
);
assert.throws(
  () => buildProxyConfigurationOptions({ useApifyProxy: 'yes' }),
  /useApifyProxy must be a boolean/i,
);

assert.equal(classifyYouTubeDocument('YouTube', 'Normal channel content'), 'normal');
assert.equal(classifyYouTubeDocument('Sorry', 'Our systems detected unusual traffic'), 'blocked');
assert.equal(classifyYouTubeDocument('YouTube', 'No results found. Try different keywords.'), 'no-results');
assert.equal(classifyYouTubeDocument('404 Not Found', "This page isn't available"), 'unavailable');
assert.equal(classifyYouTubeDocument('YouTube', 'Normal content', true), 'blocked');

assert.equal(parseCompactCount('21M subscribers'), 21_000_000);
assert.equal(parseCompactCount('1.8K videos'), 1800);
assert.equal(parseCompactCount(null), null);
assert.equal(parseDurationToSeconds('1:02:03'), 3723);
assert.equal(parseDurationToSeconds('PT2M30S'), 150);
assert.equal(formatDuration(150), '2:30');
assert.equal(detectShorts('/shorts/abc', 150), true);
assert.equal(detectShorts('/watch?v=abc', 30), false);
assert.equal(detectShorts(null, 45), true);
assert.equal(detectShorts(null, 120), false);
assert.equal(redactContactInfo('Email test@example.com or call +1 212 555 0199'), 'Email [redacted] or call [redacted]');

const parserFixture = {
  metadata: {
    channelMetadataRenderer: {
      title: 'Fixture Channel',
      description: 'Fixture description',
      externalId: 'UC_FIXTURE',
      channelUrl: 'https://www.youtube.com/channel/UC_FIXTURE',
    },
  },
  header: {
    c4TabbedHeaderRenderer: {
      channelHandleText: { runs: [{ text: '@fixture' }] },
      subscriberCountText: { simpleText: '1.2K subscribers' },
      videosCountText: { runs: [{ text: '12 videos' }] },
    },
  },
  contents: [
    {
      videoRenderer: {
        videoId: 'video123',
        title: { runs: [{ text: 'Fixture video' }] },
        viewCountText: { simpleText: '345 views' },
        publishedTimeText: { simpleText: '1 day ago' },
        lengthText: { simpleText: '2:30' },
      },
    },
    {
      channelRenderer: {
        channelId: 'UC_SEARCH',
        navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/@search-result' } } },
      },
    },
  ],
};
const parsedFixture = extractInitialData(`<script>var ytInitialData = ${JSON.stringify(parserFixture)};</script>`);
assert.equal(extractChannelMetadata(parsedFixture).title, 'Fixture Channel');
assert.equal(extractChannelMetadata(parsedFixture).subscriberText, '1.2K subscribers');
assert.equal(extractVideos(parsedFixture)[0].videoId, 'video123');
assert.deepEqual(extractSearchChannelUrls(parsedFixture, 1), ['https://www.youtube.com/@search-result']);

const mainSource = readText('src/main.ts');
const httpSource = readText('src/youtube-http.ts');
assert.match(mainSource, /maxRequestsPerCrawl/);
assert.match(mainSource, /stopped at the user's spending limit/);
assert.match(mainSource, /Actor\.pushData\(channelRecord, CHANNEL_SCRAPED_EVENT\)/);
assert.doesNotMatch(mainSource, /PlaywrightCrawler|Actor\.charge\(/);
assert.match(httpSource, /extractInitialData/);
assert.match(httpSource, /gotScraping/);
assert.doesNotMatch(httpSource, /playwright|chromium/i);

console.log('Audit checks passed.');
