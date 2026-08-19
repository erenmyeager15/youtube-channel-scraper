import { Actor, log } from 'apify';

import { normalizeActorInput, normalizeYouTubeChannelUrl } from './run-config.js';
import type { ActorInput, ChannelRecord, VideoRecord } from './types.js';
import {
  extractChannelMetadata,
  extractSearchChannelUrls,
  extractVideos,
  fetchYouTubePage,
} from './youtube-http.js';
import {
  detectShorts,
  formatDuration,
  parseCompactCount,
  parseDurationToSeconds,
  redactContactInfo,
  truncate,
} from './youtube-utils.js';

const CHANNEL_SCRAPED_EVENT = 'channel-scraped';

await Actor.init();

try {
  const input = await Actor.getInput<ActorInput>() ?? {};
  const normalized = normalizeActorInput(input);
  const proxyConfiguration = normalized.proxyOptions
    ? await Actor.createProxyConfiguration(normalized.proxyOptions)
    : undefined;
  const channelBudget = normalized.maxRequestsPerCrawl - normalized.searchKeywords.length;
  const channelQueue = [...normalized.channelUrls];
  const queuedUrls = new Set(channelQueue.map((url) => url.toLowerCase()));
  let confirmedEmptySearchCount = 0;
  let failedRequestCount = 0;
  let savedChannelCount = 0;
  let savedVideoCount = 0;
  let spendingLimitReached = false;

  for (const keyword of normalized.searchKeywords) {
    if (channelQueue.length >= channelBudget) break;
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%3D%3D`;
      const page = await fetchYouTubePage(searchUrl, proxyConfiguration);
      const discovered = extractSearchChannelUrls(page.initialData, normalized.maxChannels);
      if (discovered.length === 0) {
        confirmedEmptySearchCount += 1;
        log.info(`YouTube returned no channel matches for "${keyword}".`);
      }
      for (const rawUrl of discovered) {
        const url = normalizeYouTubeChannelUrl(rawUrl);
        if (queuedUrls.has(url.toLowerCase())) continue;
        channelQueue.push(url);
        queuedUrls.add(url.toLowerCase());
        if (channelQueue.length >= channelBudget) break;
      }
      log.info(`Discovered ${discovered.length} channel candidate(s) for "${keyword}".`);
    } catch (error) {
      failedRequestCount += 1;
      log.error(`YouTube channel search failed for "${keyword}": ${String(error)}`);
    }
  }

  const savedChannelKeys = new Set<string>();
  for (const channelUrl of channelQueue.slice(0, channelBudget)) {
    if (spendingLimitReached) break;
    try {
      const pageUrl = normalized.maxVideosPerChannel > 0
        ? `${channelUrl.replace(/\/$/, '')}/videos`
        : channelUrl;
      const page = await fetchYouTubePage(pageUrl, proxyConfiguration);
      const metadata = extractChannelMetadata(page.initialData);
      if (!metadata.title && parseCompactCount(metadata.subscriberText) === null) {
        throw new Error('No channel metadata was found in YouTube initial data');
      }

      let canonicalChannelUrl = channelUrl;
      if (metadata.canonicalUrl) {
        try {
          canonicalChannelUrl = normalizeYouTubeChannelUrl(metadata.canonicalUrl);
        } catch {
          log.debug(`Ignoring malformed canonical channel URL: ${metadata.canonicalUrl}`);
        }
      }
      const channelKey = (metadata.externalId ?? metadata.handle ?? canonicalChannelUrl).toLowerCase();
      if (savedChannelKeys.has(channelKey)) {
        log.info(`Skipping duplicate YouTube channel: ${canonicalChannelUrl}`);
        continue;
      }

      const channelRecord: ChannelRecord = {
        channelUrl: canonicalChannelUrl,
        channelName: metadata.title,
        handle: metadata.handle,
        subscriberCount: metadata.subscriberText,
        subscriberCountNumber: parseCompactCount(metadata.subscriberText),
        totalViews: null,
        totalViewsNumber: null,
        totalVideoCount: metadata.videoCountText,
        totalVideoCountNumber: parseCompactCount(metadata.videoCountText),
        joinDate: null,
        country: null,
        channelDescription: redactContactInfo(truncate(metadata.description, 2000)),
        avatarImageUrl: metadata.avatarUrl,
        bannerImageUrl: metadata.bannerUrl,
        channelCategory: null,
        isVerified: metadata.isVerified,
        socialLinks: [],
        scrapedAt: new Date().toISOString(),
      };

      const chargeResult = await Actor.pushData(channelRecord, CHANNEL_SCRAPED_EVENT);
      const recordWasSaved = chargeResult.chargedCount > 0 || !chargeResult.eventChargeLimitReached;
      if (!recordWasSaved) {
        spendingLimitReached = true;
        log.warning(`Charge limit reached for ${CHANNEL_SCRAPED_EVENT}; the channel was not saved.`);
        break;
      }

      savedChannelKeys.add(channelKey);
      savedChannelCount += 1;
      const videoRecords = buildVideoRecords(
        page.initialData,
        canonicalChannelUrl,
        metadata.title,
        normalized.maxVideosPerChannel,
        normalized.includeShorts,
      );
      if (videoRecords.length > 0) {
        await Actor.pushData(videoRecords);
        savedVideoCount += videoRecords.length;
      }
      log.info(`Saved ${metadata.title ?? canonicalChannelUrl} with ${videoRecords.length} video row(s).`);

      if (chargeResult.eventChargeLimitReached) spendingLimitReached = true;
    } catch (error) {
      failedRequestCount += 1;
      log.error(`YouTube channel request failed for ${channelUrl}: ${String(error)}`);
    }
  }

  const allSearchesCompletedEmpty = normalized.channelUrls.length === 0
    && confirmedEmptySearchCount === normalized.searchKeywords.length
    && failedRequestCount === 0;
  if (savedChannelCount === 0 && !spendingLimitReached && !allSearchesCompletedEmpty) {
    throw new Error(`No YouTube channel rows were saved. Failed requests: ${failedRequestCount}.`);
  }
  if (spendingLimitReached) {
    log.warning(`YouTube crawl stopped at the user's spending limit after ${savedChannelCount} saved channel row(s).`);
  }
  log.info(`Run complete. Saved channel rows: ${savedChannelCount}. Saved video rows: ${savedVideoCount}. Failed requests: ${failedRequestCount}.`);
} catch (error) {
  await Actor.fail(error instanceof Error ? error.message : String(error));
}

await Actor.exit();

function buildVideoRecords(
  initialData: Record<string, any>,
  channelUrl: string,
  channelName: string | null,
  maximum: number,
  includeShorts: boolean,
): VideoRecord[] {
  return extractVideos(initialData)
    .map((video): VideoRecord => {
      const durationSeconds = parseDurationToSeconds(video.lengthText);
      const isShorts = detectShorts(video.navigationUrl, durationSeconds);
      return {
        channelUrl,
        channelName,
        videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        videoTitle: video.title,
        viewCount: video.viewText,
        viewCountNumber: parseCompactCount(video.viewText),
        likeCount: null,
        likeCountNumber: null,
        commentCount: null,
        commentCountNumber: null,
        durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        publishedDate: video.publishedText,
        thumbnailUrl: video.thumbnailUrl,
        videoDescription: null,
        tags: [],
        category: null,
        isShorts,
        scrapedAt: new Date().toISOString(),
      };
    })
    .filter((video) => includeShorts || !video.isShorts)
    .slice(0, maximum);
}
