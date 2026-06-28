import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';
import { ActorInput } from './types.js';
import { channelHandler, getScrapeState, searchHandler } from './routes.js';

await Actor.init();

const input = await Actor.getInput<ActorInput>() ?? {};

const {
  channelUrls = [],
  searchKeywords = [],
  maxChannels = 10,
  maxVideosPerChannel = 20,
  includeShorts = false,
  proxyConfiguration: proxyConfig,
} = input;

const proxyConfiguration = proxyConfig
  ? await Actor.createProxyConfiguration({
      useApifyProxy: proxyConfig.useApifyProxy ?? true,
      apifyProxyGroups: proxyConfig.apifyProxyGroups,
      proxyUrls: proxyConfig.proxyUrls,
    })
  : undefined;

let failedRequestCount = 0;

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 3,
  minConcurrency: 1,
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
      throw new Error('Charge limit reached; stopping remaining YouTube requests.');
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

for (const rawUrl of channelUrls) {
  let normalizedUrl = rawUrl.trim();
  if (!normalizedUrl.startsWith('http')) {
    if (normalizedUrl.includes('youtube.com')) {
      normalizedUrl = `https://${normalizedUrl}`;
    } else {
      normalizedUrl = `https://www.youtube.com/${normalizedUrl.replace(/^\/+/, '')}`;
    }
  }
  normalizedUrl = normalizedUrl.replace(/\/videos\/?$/, '');

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

if (requests.length === 0) {
  log.error('No channel URLs or search keywords provided. Provide at least one.');
  throw new Error('No channel URLs or search keywords provided. Provide at least one.');
}

log.info(`Starting crawl with ${requests.length} initial request(s)`);

await crawler.run(requests);

const scrapeState = getScrapeState();

if (scrapeState.spendingLimitReached) {
  throw new Error('YouTube crawl stopped because the charge limit was reached.');
}

if (scrapeState.chargedChannelCount === 0) {
  throw new Error(`No YouTube channel rows were saved. Failed requests: ${failedRequestCount}.`);
}

log.info(`Crawl complete. Saved channel rows: ${scrapeState.chargedChannelCount}. Saved video rows: ${scrapeState.savedVideoCount}. Failed requests: ${failedRequestCount}.`);

await Actor.exit();
