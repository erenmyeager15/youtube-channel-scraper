import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { ActorInput } from './types.js';
import { channelHandler, getScrapeState, searchHandler } from './routes.js';
import { normalizeActorInput } from './run-config.js';

await Actor.init();

const input = await Actor.getInput<ActorInput>() ?? {};
const normalizedInput = normalizeActorInput(input);
const {
  channelUrls,
  searchKeywords,
  maxChannels,
  maxVideosPerChannel,
  includeShorts,
  proxyOptions,
  maxRequestsPerCrawl,
} = normalizedInput;

const proxyConfiguration = proxyOptions
  ? await Actor.createProxyConfiguration(proxyOptions)
  : undefined;

let failedRequestCount = 0;

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 3,
  minConcurrency: 1,
  maxRequestsPerCrawl,
  requestHandlerTimeoutSecs: 300,
  sessionPoolOptions: {
    maxPoolSize: 50,
  },
  maxSessionRotations: 3,
  retryOnBlocked: true,
  maxRequestRetries: 3,
  requestHandler: async (context) => {
    if (getScrapeState().spendingLimitReached) {
      context.request.noRetry = true;
      context.log.info('Skipping queued YouTube request because the user spending limit has been reached.');
      return;
    }

    const label = context.request.userData['label'] as string | undefined;

    if (label === 'channel') {
      await channelHandler(context);
    } else if (label === 'search') {
      await searchHandler(context);
    } else {
      await channelHandler(context);
    }
  },
  failedRequestHandler: async ({ request, log: reqLog }, error) => {
    failedRequestCount += 1;
    reqLog.error(`Request ${request.url} failed after retries: ${error.message}`);
  },
});

const requests: Array<{
  url: string;
  userData: Record<string, unknown>;
}> = [];

for (const normalizedUrl of channelUrls) {
  requests.push({
    url: normalizedUrl,
    userData: {
      label: 'channel',
      channelUrl: normalizedUrl,
      maxVideos: maxVideosPerChannel,
      includeShorts,
    },
  });
}

for (const keyword of searchKeywords) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%3D%3D`;
  requests.push({
    url: searchUrl,
    userData: {
      label: 'search',
      keyword,
      maxChannels,
      maxVideosPerChannel,
      includeShorts,
    },
  });
}

log.info(
  `Starting crawl with ${requests.length} initial request(s); `
  + `at most ${maxRequestsPerCrawl - searchKeywords.length} channel pages will be handled.`,
);

await crawler.run(requests);

const scrapeState = getScrapeState();

const allSearchesCompletedEmpty = channelUrls.length === 0
  && scrapeState.confirmedEmptySearchCount === searchKeywords.length
  && failedRequestCount === 0;

if (scrapeState.chargedChannelCount === 0 && !scrapeState.spendingLimitReached && !allSearchesCompletedEmpty) {
  throw new Error(`No YouTube channel rows were saved. Failed requests: ${failedRequestCount}.`);
}

if (allSearchesCompletedEmpty) {
  log.info(`YouTube returned no matching channels for ${scrapeState.confirmedEmptySearchCount} search keyword(s).`);
}

if (scrapeState.spendingLimitReached) {
  log.warning(
    `YouTube crawl stopped at the user's spending limit after `
    + `${scrapeState.chargedChannelCount} saved channel row(s).`,
  );
}

log.info(`Crawl complete. Saved channel rows: ${scrapeState.chargedChannelCount}. Saved video rows: ${scrapeState.savedVideoCount}. Failed requests: ${failedRequestCount}.`);

await Actor.exit();
