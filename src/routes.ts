import { Actor } from 'apify';
import type { PlaywrightCrawlingContext } from 'crawlee';

import { normalizeYouTubeChannelUrl } from './run-config.js';
import type { ChannelRecord, ChannelUserData, SearchUserData, VideoRecord } from './types.js';
import {
  classifyYouTubeDocument,
  detectShorts,
  formatDuration,
  parseCompactCount,
  parseDurationToSeconds,
  redactContactInfo,
  truncate,
} from './youtube-utils.js';

const CHANNEL_SCRAPED_EVENT = 'channel-scraped';

let chargedChannelCount = 0;
let savedVideoCount = 0;
let confirmedEmptySearchCount = 0;
let spendingLimitReached = false;
const activeOrSavedChannelKeys = new Set<string>();

export function getScrapeState() {
  return {
    chargedChannelCount,
    savedVideoCount,
    confirmedEmptySearchCount,
    spendingLimitReached,
  };
}

function randomDelay(min = 500, max = 1500): Promise<void> {
  const milliseconds = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function inspectDocument(page: PlaywrightCrawlingContext['page']) {
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const hasCaptcha = await page
    .locator('iframe[src*="recaptcha"], form[action*="/sorry/"], #captcha-form')
    .count()
    .then((count) => count > 0)
    .catch(() => false);
  return classifyYouTubeDocument(title, bodyText.slice(0, 50_000), hasCaptcha);
}

export async function channelHandler(context: PlaywrightCrawlingContext): Promise<void> {
  const { page, request, log, session } = context;
  const { channelUrl, maxVideos, includeShorts } = request.userData as ChannelUserData;
  let reservedChannelKey: string | null = null;
  let channelWasSaved = false;

  if (spendingLimitReached) {
    request.noRetry = true;
    log.info(`Skipping ${channelUrl} because the user spending limit has been reached.`);
    return;
  }

  log.info(`Scraping channel: ${channelUrl}`);

  try {
    await randomDelay();
    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .waitForFunction(() => Boolean((window as unknown as { ytInitialData?: unknown }).ytInitialData), { timeout: 15_000 })
      .catch(() => undefined);
    await randomDelay(800, 1800);

    const documentState = await inspectDocument(page);
    if (documentState === 'blocked') {
      session?.retire();
      throw new Error(`YouTube blocked the channel request for ${channelUrl}`);
    }
    if (documentState === 'unavailable') {
      request.noRetry = true;
      throw new Error(`YouTube channel is unavailable: ${channelUrl}`);
    }

    const channelData = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const initialData: any = (window as any).ytInitialData;
      const metadata = initialData?.metadata?.channelMetadataRenderer ?? {};
      const legacyHeader = initialData?.header?.c4TabbedHeaderRenderer ?? {};
      const pageHeader = initialData?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};

      const title: string | null = metadata.title ?? legacyHeader.title ?? null;
      const description: string | null = metadata.description ?? null;
      const handle: string | null =
        legacyHeader.channelHandleText?.runs?.[0]?.text
        ?? (metadata.vanityChannelUrl ? `@${String(metadata.vanityChannelUrl).split('/@')[1] ?? ''}` : null);

      const avatars = metadata.avatar?.thumbnails ?? legacyHeader.avatar?.thumbnails ?? [];
      const avatarUrl: string | null = avatars.length ? avatars[avatars.length - 1].url : null;
      const banners = legacyHeader.banner?.thumbnails ?? [];
      const bannerUrl: string | null = banners.length ? banners[banners.length - 1].url : null;

      let subscriberText: string | null = legacyHeader.subscriberCountText?.simpleText ?? null;
      let videoCountText: string | null = legacyHeader.videosCountText?.runs?.map((run: any) => run.text).join('') ?? null;

      if (!subscriberText || !videoCountText) {
        const rows = pageHeader?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
        for (const row of rows) {
          for (const part of row.metadataParts ?? []) {
            const text: string = part.text?.content ?? '';
            if (/subscriber/i.test(text) && !subscriberText) subscriberText = text;
            else if (/video/i.test(text) && !videoCountText) videoCountText = text;
          }
        }
      }

      const badgeText = `${JSON.stringify(legacyHeader.badges ?? [])}${JSON.stringify(pageHeader?.title ?? '')}`;
      const isVerified = /verified|official artist/i.test(badgeText);
      const externalId: string | null = metadata.externalId ?? legacyHeader.channelId ?? null;
      const canonicalUrl: string | null = metadata.channelUrl
        ?? (externalId ? `https://www.youtube.com/channel/${externalId}` : null);

      return {
        title,
        description,
        handle,
        avatarUrl,
        bannerUrl,
        subscriberText,
        videoCountText,
        isVerified,
        externalId,
        canonicalUrl,
      };
    });

    if (!channelData.title && parseCompactCount(channelData.subscriberText) === null) {
      session?.retire();
      throw new Error(`No channel metadata was extracted for ${channelUrl}; the page may be blocked or changed.`);
    }

    let canonicalChannelUrl = channelUrl;
    if (channelData.canonicalUrl) {
      try {
        canonicalChannelUrl = normalizeYouTubeChannelUrl(channelData.canonicalUrl);
      } catch {
        log.debug(`Ignoring malformed canonical channel URL from YouTube: ${channelData.canonicalUrl}`);
      }
    }
    const channelKey = (channelData.externalId ?? channelData.handle ?? canonicalChannelUrl).toLowerCase();
    if (activeOrSavedChannelKeys.has(channelKey)) {
      request.noRetry = true;
      log.info(`Skipping duplicate YouTube channel: ${canonicalChannelUrl}`);
      session?.retire();
      return;
    }
    activeOrSavedChannelKeys.add(channelKey);
    reservedChannelKey = channelKey;

    const channelRecord: ChannelRecord = {
      channelUrl: canonicalChannelUrl,
      channelName: channelData.title,
      handle: channelData.handle,
      subscriberCount: channelData.subscriberText,
      subscriberCountNumber: parseCompactCount(channelData.subscriberText),
      totalViews: null,
      totalViewsNumber: null,
      totalVideoCount: channelData.videoCountText,
      totalVideoCountNumber: parseCompactCount(channelData.videoCountText),
      joinDate: null,
      country: null,
      channelDescription: redactContactInfo(truncate(channelData.description, 2000)),
      avatarImageUrl: channelData.avatarUrl,
      bannerImageUrl: channelData.bannerUrl,
      channelCategory: null,
      isVerified: channelData.isVerified,
      socialLinks: [],
      scrapedAt: new Date().toISOString(),
    };

    const videoRecords = await collectLatestVideos(
      context,
      canonicalChannelUrl,
      channelRecord.channelName,
      maxVideos,
      includeShorts,
    );

    const chargeResult = await Actor.pushData(channelRecord, CHANNEL_SCRAPED_EVENT);
    const recordWasSaved = chargeResult.chargedCount > 0 || !chargeResult.eventChargeLimitReached;
    if (!recordWasSaved) {
      spendingLimitReached = true;
      request.noRetry = true;
      activeOrSavedChannelKeys.delete(channelKey);
      reservedChannelKey = null;
      log.warning(`Charge limit reached for ${CHANNEL_SCRAPED_EVENT}; the channel was not saved.`);
      session?.retire();
      return;
    }

    channelWasSaved = true;
    chargedChannelCount += 1;
    log.info(`Saved channel row: ${channelRecord.channelName ?? canonicalChannelUrl}`);

    if (videoRecords.length > 0) {
      try {
        await Actor.pushData(videoRecords);
        savedVideoCount += videoRecords.length;
        log.info(`Saved ${videoRecords.length} latest-video row(s) for ${channelRecord.channelName ?? canonicalChannelUrl}`);
      } catch (error) {
        log.warning(`Channel metadata was saved, but its video rows could not be stored: ${String(error)}`);
      }
    }

    if (chargeResult.eventChargeLimitReached) {
      spendingLimitReached = true;
      request.noRetry = true;
      log.warning('The user spending limit was reached after saving the current channel and its available video rows.');
    }

    session?.retire();
  } catch (error) {
    if (reservedChannelKey && !channelWasSaved) activeOrSavedChannelKeys.delete(reservedChannelKey);
    log.error(`Error scraping channel ${channelUrl}: ${String(error)}`);
    session?.retire();
    throw error;
  }
}

async function collectLatestVideos(
  context: PlaywrightCrawlingContext,
  channelUrl: string,
  channelName: string | null,
  maxVideos: number,
  includeShorts: boolean,
): Promise<VideoRecord[]> {
  if (maxVideos < 1) return [];

  const { page, log, session } = context;
  const videosTabUrl = `${channelUrl.replace(/\/$/, '')}/videos`;

  try {
    await page.goto(videosTabUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .waitForFunction(() => Boolean((window as unknown as { ytInitialData?: unknown }).ytInitialData), { timeout: 15_000 })
      .catch(() => undefined);
    await randomDelay(800, 1500);

    const documentState = await inspectDocument(page);
    if (documentState === 'blocked') {
      session?.retire();
      log.warning(`YouTube blocked the latest-video page for ${channelUrl}; saving channel metadata without videos.`);
      return [];
    }
    if (documentState === 'unavailable' || documentState === 'no-results') return [];

    const videos = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const initialData: any = (window as any).ytInitialData;
      const output: Array<{
        videoId: string;
        title: string | null;
        viewText: string | null;
        publishedText: string | null;
        lengthText: string | null;
        thumbnailUrl: string | null;
        navigationUrl: string | null;
      }> = [];
      const seen = new Set<string>();

      const findText = (object: any, pattern: RegExp): string | null => {
        let result: string | null = null;
        const visit = (value: any): void => {
          if (result || !value || typeof value !== 'object') return;
          if (typeof value.text === 'string' && pattern.test(value.text)) result = value.text;
          else if (typeof value.content === 'string' && pattern.test(value.content)) result = value.content;
          else for (const child of Object.values(value)) visit(child);
        };
        visit(object);
        return result;
      };

      const findNavigationUrl = (object: any, videoId: string): string | null => {
        let fallback: string | null = null;
        const visit = (value: any): string | null => {
          if (!value || typeof value !== 'object') return null;
          for (const [key, child] of Object.entries(value)) {
            if (typeof child === 'string' && /url/i.test(key)) {
              if (child.includes(`/shorts/${videoId}`)) return child;
              if (child.includes(`/watch?v=${videoId}`)) fallback = child;
            } else if (child && typeof child === 'object') {
              const found = visit(child);
              if (found) return found;
            }
          }
          return null;
        };
        return visit(object) ?? fallback;
      };

      const walk = (object: any): void => {
        if (!object || typeof object !== 'object') return;

        const videoRenderer = object.videoRenderer;
        if (videoRenderer?.videoId && !seen.has(videoRenderer.videoId)) {
          seen.add(videoRenderer.videoId);
          const thumbnails = videoRenderer.thumbnail?.thumbnails ?? [];
          output.push({
            videoId: videoRenderer.videoId,
            title: videoRenderer.title?.runs?.[0]?.text ?? null,
            viewText: videoRenderer.viewCountText?.simpleText
              ?? videoRenderer.viewCountText?.runs?.map((run: any) => run.text).join('')
              ?? null,
            publishedText: videoRenderer.publishedTimeText?.simpleText ?? null,
            lengthText: videoRenderer.lengthText?.simpleText ?? null,
            thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1].url : null,
            navigationUrl: findNavigationUrl(videoRenderer, videoRenderer.videoId),
          });
        }

        const lockup = object.lockupViewModel;
        if (lockup?.contentId && /VIDEO/i.test(lockup.contentType ?? '') && !seen.has(lockup.contentId)) {
          seen.add(lockup.contentId);
          const metadata = lockup.metadata?.lockupMetadataViewModel;
          const rows = metadata?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
          let viewText: string | null = null;
          let publishedText: string | null = null;
          for (const row of rows) {
            for (const part of row.metadataParts ?? []) {
              const text: string = part.text?.content ?? '';
              if (/view/i.test(text) && !viewText) viewText = text;
              else if (/(ago|stream|premiere)/i.test(text) && !publishedText) publishedText = text;
            }
          }
          const thumbnailSources = lockup.contentImage?.thumbnailViewModel?.image?.sources ?? [];
          output.push({
            videoId: lockup.contentId,
            title: metadata?.title?.content ?? null,
            viewText,
            publishedText,
            lengthText: findText(lockup.contentImage, /^\d{1,2}:\d{2}(?::\d{2})?$/),
            thumbnailUrl: thumbnailSources.length ? thumbnailSources[thumbnailSources.length - 1].url : null,
            navigationUrl: findNavigationUrl(lockup, lockup.contentId),
          });
        }

        for (const child of Object.values(object)) walk(child);
      };

      walk(initialData);
      return output;
    });

    return videos
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
      .slice(0, maxVideos);
  } catch (error) {
    log.warning(`Could not collect latest videos for ${channelUrl}; saving channel metadata only: ${String(error)}`);
    return [];
  }
}

export async function searchHandler(context: PlaywrightCrawlingContext): Promise<void> {
  const { page, request, log, session } = context;
  const searchData = request.userData as SearchUserData;
  const { keyword, maxChannels } = searchData;

  if (spendingLimitReached) {
    request.noRetry = true;
    log.info(`Skipping search "${keyword}" because the user spending limit has been reached.`);
    return;
  }

  log.info(`Searching YouTube for channels matching: ${keyword}`);

  try {
    await randomDelay();
    await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .waitForFunction(() => Boolean((window as unknown as { ytInitialData?: unknown }).ytInitialData), { timeout: 15_000 })
      .catch(() => undefined);
    await randomDelay(800, 1600);

    const documentState = await inspectDocument(page);
    if (documentState === 'blocked') {
      session?.retire();
      throw new Error(`YouTube blocked the channel search for "${keyword}"`);
    }
    if (documentState === 'no-results') {
      confirmedEmptySearchCount += 1;
      request.noRetry = true;
      log.info(`YouTube returned no channel matches for "${keyword}".`);
      session?.retire();
      return;
    }

    const discoveredUrls = await page.evaluate((maximum: number) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const initialData: any = (window as any).ytInitialData;
      const urls = new Set<string>();

      const addUrl = (rawUrl: unknown): void => {
        if (urls.size >= maximum || typeof rawUrl !== 'string') return;
        if (!/^\/(?:@|channel\/|c\/|user\/)/i.test(rawUrl)) return;
        const cleanPath = rawUrl.split(/[?#]/)[0];
        urls.add(`https://www.youtube.com${cleanPath}`);
      };

      const walk = (object: any): void => {
        if (!object || typeof object !== 'object' || urls.size >= maximum) return;
        const channel = object.channelRenderer;
        if (channel) {
          addUrl(channel.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url);
          if (channel.channelId) addUrl(`/channel/${channel.channelId}`);
        }
        for (const [key, child] of Object.entries(object)) {
          if (typeof child === 'string' && /(?:url|canonicalBaseUrl)/i.test(key)) addUrl(child);
          else if (child && typeof child === 'object') walk(child);
        }
      };

      walk(initialData);

      for (const link of document.querySelectorAll('ytd-channel-renderer a[href], a#main-link[href]')) {
        addUrl(link.getAttribute('href'));
        if (urls.size >= maximum) break;
      }
      return [...urls];
    }, maxChannels);

    const channelUrls: string[] = [];
    for (const rawUrl of discoveredUrls) {
      try {
        const normalizedUrl = normalizeYouTubeChannelUrl(rawUrl);
        if (!channelUrls.includes(normalizedUrl)) channelUrls.push(normalizedUrl);
      } catch {
        // Ignore non-channel navigation URLs found in YouTube's generic page payload.
      }
      if (channelUrls.length >= maxChannels) break;
    }

    if (channelUrls.length === 0) {
      session?.retire();
      throw new Error(`The YouTube search page loaded but no channel URLs could be extracted for "${keyword}".`);
    }

    await context.addRequests(channelUrls.map((url) => ({
      url,
      userData: {
        label: 'channel',
        channelUrl: url,
        maxVideos: searchData.maxVideosPerChannel,
        includeShorts: searchData.includeShorts,
      },
    })));

    log.info(`Queued ${channelUrls.length} channel(s) discovered for "${keyword}".`);
    session?.retire();
  } catch (error) {
    log.error(`Error searching for "${keyword}": ${String(error)}`);
    session?.retire();
    throw error;
  }
}
