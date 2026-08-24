import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const readText = (path) => fs.readFileSync(new URL(path, root), 'utf8');

const {
  MAX_CHANNELS_PER_RUN,
  MAX_DETAILED_CHANNELS_PER_RUN,
  MAX_DETAILED_VIDEOS_PER_CHANNEL,
  MAX_SEARCH_KEYWORDS,
  buildProxyConfigurationOptions,
  normalizeActorInput,
  normalizeYouTubeChannelUrl,
} = await import('../dist/run-config.js');
const {
  buildPublicChannelLinks,
  classifyYouTubeDocument,
  detectShorts,
  formatDuration,
  parseCompactCount,
  parseDurationToSeconds,
  redactContactInfo,
} = await import('../dist/youtube-utils.js');
const {
  classifyExternalLink,
  extractChannelAbout,
  extractChannelMetadata,
  extractInitialData,
  extractPlayerApiConfig,
  extractPlayerResponse,
  extractSearchChannelUrls,
  extractVideoDetails,
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
assert.equal(actor.defaultRunOptions.timeoutSecs, 900);
assert.equal(JSON.parse(actor.exampleRunInput.body).mode, 'detailed');
assert.equal(schema.properties.channelUrls.maxItems, MAX_CHANNELS_PER_RUN);
assert.equal(schema.properties.searchKeywords.maxItems, MAX_SEARCH_KEYWORDS);
assert.deepEqual(schema.properties.mode.enum, ['fast', 'detailed']);
assert.equal(schema.properties.maxDetailedVideosPerChannel.maximum, MAX_DETAILED_VIDEOS_PER_CHANNEL);

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
assert.equal(normalized.mode, 'fast');
assert.equal(normalized.maxDetailedVideosPerChannel, 1);
assert.equal(normalized.maxRequestsPerCrawl, MAX_CHANNELS_PER_RUN + 1);
assert.equal(normalized.proxyOptions, undefined);
const detailed = normalizeActorInput({
  channelUrls: ['@mkbhd'],
  mode: 'detailed',
  maxDetailedVideosPerChannel: MAX_DETAILED_VIDEOS_PER_CHANNEL,
});
assert.equal(detailed.mode, 'detailed');
assert.equal(detailed.maxRequestsPerCrawl, MAX_DETAILED_CHANNELS_PER_RUN);
assert.equal(detailed.maxDetailedVideosPerChannel, MAX_DETAILED_VIDEOS_PER_CHANNEL);
assert.throws(() => normalizeActorInput({ channelUrls: ['@mkbhd'], maxChannels: 0 }), /maxChannels/i);
assert.throws(() => normalizeActorInput({ channelUrls: ['@mkbhd'], mode: 'slow' }), /mode/i);
assert.throws(
  () => normalizeActorInput({ channelUrls: ['@mkbhd'], mode: 'detailed', maxChannels: 11 }),
  /detailed mode/i,
);
assert.throws(
  () => normalizeActorInput({ channelUrls: ['@mkbhd'], maxDetailedVideosPerChannel: 6 }),
  /maxDetailedVideosPerChannel/i,
);
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
assert.equal(classifyExternalLink('https://m.facebook.com/fixture'), 'facebook');
assert.equal(classifyExternalLink('https://instagram.com/fixture'), 'instagram');
assert.equal(classifyExternalLink('https://linkedin.com/company/fixture'), 'linkedin');
assert.equal(classifyExternalLink('https://twitter.com/fixture'), 'x');
assert.equal(classifyExternalLink('https://youtu.be/video123'), 'youtube');
assert.equal(classifyExternalLink('https://tiktok.com/@fixture'), 'tiktok');
assert.equal(classifyExternalLink('https://reddit.com/r/fixture'), 'reddit');
assert.equal(classifyExternalLink('https://twitch.tv/fixture'), 'twitch');
assert.equal(classifyExternalLink('https://threads.net/@fixture'), 'threads');
assert.equal(classifyExternalLink('https://discord.gg/fixture'), 'discord');
assert.equal(classifyExternalLink('https://example.com/fixture'), 'website');
assert.deepEqual(
  buildPublicChannelLinks('https://www.youtube.com/@fixture', 'UC_FIXTURE'),
  {
    videosUrl: 'https://www.youtube.com/channel/UC_FIXTURE/videos',
    shortsUrl: 'https://www.youtube.com/channel/UC_FIXTURE/shorts',
    liveStreamsUrl: 'https://www.youtube.com/channel/UC_FIXTURE/streams',
    playlistsUrl: 'https://www.youtube.com/channel/UC_FIXTURE/playlists',
    communityUrl: 'https://www.youtube.com/channel/UC_FIXTURE/community',
  },
);
assert.equal(
  buildPublicChannelLinks('https://www.youtube.com/@fixture/', null).shortsUrl,
  'https://www.youtube.com/@fixture/shorts',
);

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
      aboutChannelViewModel: {
        description: 'Fixture about description',
        country: 'United States',
        subscriberCountText: '1.2K subscribers',
        viewCountText: '12,345 views',
        joinedDateText: { content: 'Joined Jan 2, 2020' },
        videoCountText: '12 videos',
        canonicalChannelUrl: 'https://www.youtube.com/@fixture',
        links: [
          {
            channelExternalLinkViewModel: {
              title: { content: 'Official website' },
              link: { content: 'example.com/fixture' },
            },
          },
          {
            channelExternalLinkViewModel: {
              title: { content: 'Instagram' },
              link: { content: 'https://www.instagram.com/fixture/' },
            },
          },
          {
            channelExternalLinkViewModel: {
              title: { content: 'X' },
              link: {
                content: 'X profile',
                commandRuns: [{
                  onTap: {
                    innertubeCommand: {
                      commandMetadata: {
                        webCommandMetadata: {
                          url: '/redirect?q=https%3A%2F%2Fx.com%2Ffixture',
                        },
                      },
                    },
                  },
                }],
              },
            },
          },
          {
            channelExternalLinkViewModel: {
              title: { content: 'LinkedIn' },
              link: { content: 'linkedin.com/company/fixture' },
            },
          },
          {
            channelExternalLinkViewModel: {
              title: { content: 'person@example.com' },
              link: { content: 'https://example.org/contact' },
            },
          },
          {
            channelExternalLinkViewModel: {
              title: { content: 'Email' },
              link: { content: 'person@example.com' },
            },
          },
          { channelExternalLinkViewModel: { link: { content: 'example.com/fixture' } } },
        ],
      },
    },
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
const parsedAbout = extractChannelAbout(parsedFixture);
assert.equal(parsedAbout?.totalViewsText, '12,345 views');
assert.equal(parsedAbout?.joinDate, 'Jan 2, 2020');
assert.equal(parsedAbout?.country, 'United States');
assert.deepEqual(parsedAbout?.socialLinks, [
  'https://example.com/fixture',
  'https://www.instagram.com/fixture/',
  'https://x.com/fixture',
  'https://linkedin.com/company/fixture',
  'https://example.org/contact',
]);
assert.deepEqual(parsedAbout?.websiteLinks, [
  'https://example.com/fixture',
  'https://example.org/contact',
]);
assert.deepEqual(parsedAbout?.socialProfiles.instagram, ['https://www.instagram.com/fixture/']);
assert.deepEqual(parsedAbout?.socialProfiles.linkedin, ['https://linkedin.com/company/fixture']);
assert.deepEqual(parsedAbout?.socialProfiles.x, ['https://x.com/fixture']);
assert.equal(parsedAbout?.externalLinks[0]?.title, 'Official website');
assert.equal(parsedAbout?.externalLinks[4]?.title, null);
assert.doesNotMatch(JSON.stringify(parsedAbout), /person@example\.com/i);
assert.equal(extractVideos(parsedFixture)[0].videoId, 'video123');
assert.deepEqual(extractSearchChannelUrls(parsedFixture, 1), ['https://www.youtube.com/@search-result']);

const videoInitialFixture = {
  contents: [
    {
      videoPrimaryInfoRenderer: {
        viewCount: { videoViewCountRenderer: { originalViewCount: { simpleText: '9,876 views' } } },
      },
    },
    { likeCountEntity: { likeCountIfIndifferentNumber: 5432 } },
    { commentsHeaderRenderer: { countText: { simpleText: '321 Comments' } } },
  ],
};
const playerFixture = {
  videoDetails: {
    title: 'Detailed fixture video',
    lengthSeconds: '150',
    keywords: ['testing', 'analytics'],
    shortDescription: 'Fixture video description',
    viewCount: '9876',
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/fixture.jpg' }] },
  },
  microformat: {
    playerMicroformatRenderer: {
      category: 'Science & Technology',
      publishDate: '2026-08-22',
      likeCount: '5432',
    },
  },
};
const playerHtml = `<script>var ytInitialPlayerResponse = {"responseContext":{}};</script>`
  + `<script>ytcfg.set({"INNERTUBE_API_KEY":"fixture-key","INNERTUBE_CLIENT_VERSION":"2.20260823.01.00"});</script>`
  + `<script>var ytInitialPlayerResponse = ${JSON.stringify(playerFixture)};</script>`;
assert.deepEqual(extractPlayerApiConfig(playerHtml), {
  apiKey: 'fixture-key',
  clientVersion: '2.20260823.01.00',
});
assert.equal(extractPlayerResponse(playerHtml).videoDetails.title, 'Detailed fixture video');
const videoDetails = extractVideoDetails(videoInitialFixture, playerHtml);
assert.equal(videoDetails.viewCount, '9,876 views');
assert.equal(videoDetails.likeCountNumber, 5432);
assert.equal(videoDetails.commentCountNumber, 321);
assert.equal(videoDetails.durationSeconds, 150);
assert.equal(videoDetails.publishedDate, '2026-08-22');
assert.equal(videoDetails.category, 'Science & Technology');
assert.deepEqual(videoDetails.tags, ['testing', 'analytics']);

const metaOnlyDetails = extractVideoDetails({}, [
  '<meta name="title" content="Metadata fixture">',
  '<meta name="keywords" content="video, sharing, camera phone, video phone, free, upload">',
  '<meta name="keywords" content="one, two &amp; three">',
  '<meta itemprop="duration" content="PT4M5S">',
  '<meta itemprop="datePublished" content="2026-08-23T10:00:00Z">',
  '<meta itemprop="genre" content="Education">',
].join(''));
assert.equal(metaOnlyDetails.title, 'Metadata fixture');
assert.equal(metaOnlyDetails.durationSeconds, 245);
assert.equal(metaOnlyDetails.publishedDate, '2026-08-23T10:00:00Z');
assert.equal(metaOnlyDetails.category, 'Education');
assert.deepEqual(metaOnlyDetails.tags, ['one', 'two & three']);

const embeddedOnlyHtml = `<script>${JSON.stringify({
  videoDetails: {
    videoId: 'embedded123',
    title: 'Embedded fixture',
    keywords: ['creator research'],
    shortDescription: 'Embedded description',
    lengthSeconds: '90',
  },
  microformat: {
    playerMicroformatRenderer: {
      category: 'Howto & Style',
      publishDate: '2026-08-20',
    },
  },
})}</script>`;
const embeddedOnlyDetails = extractVideoDetails({}, embeddedOnlyHtml);
assert.equal(embeddedOnlyDetails.title, 'Embedded fixture');
assert.equal(embeddedOnlyDetails.category, 'Howto & Style');
assert.equal(embeddedOnlyDetails.publishedDate, '2026-08-20');
assert.deepEqual(embeddedOnlyDetails.tags, ['creator research']);

const mainSource = readText('src/main.ts');
const httpSource = readText('src/youtube-http.ts');
assert.match(mainSource, /maxRequestsPerCrawl/);
assert.match(mainSource, /stopped at the user's spending limit/);
assert.match(mainSource, /keeping the video-page fields/);
assert.match(mainSource, /Actor\.pushData\(channelRecord, CHANNEL_SCRAPED_EVENT\)/);
assert.doesNotMatch(mainSource, /PlaywrightCrawler|Actor\.charge\(/);
assert.match(httpSource, /extractInitialData/);
assert.match(httpSource, /gotScraping/);
assert.doesNotMatch(httpSource, /playwright|chromium/i);

console.log('Audit checks passed.');
