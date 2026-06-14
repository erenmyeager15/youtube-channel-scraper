import { PlaywrightCrawlingContext } from 'crawlee';
import { Actor } from 'apify';
import { ChannelRecord, VideoRecord, ChannelUserData, SearchUserData } from './types.js';

function randomDelay(min = 500, max = 1500): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntSafe(text: string | null): number | null {
  if (!text) return null;
  // Match the first number with an optional K/M/B suffix, ignoring trailing words
  // like "subscribers" (whose 'b' must not be read as a billions suffix).
  const m = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  let num = parseFloat(m[1]);
  if (isNaN(num)) return null;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'B') num *= 1_000_000_000;
  else if (suffix === 'M') num *= 1_000_000;
  else if (suffix === 'K') num *= 1_000;
  return Math.round(num);
}

function parseDurationToSeconds(text: string | null): number | null {
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return null;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncate(text: string | null, maxLen: number): string | null {
  if (!text) return null;
  return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
}

function redactContactInfo(text: string | null): string | null {
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/(?:\+?\d[\s().-]?){8,}\d/g, '[redacted]');
}

function extractNumber(text: string | null): number | null {
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return isNaN(num) ? null : num;
}

export async function channelHandler(context: PlaywrightCrawlingContext): Promise<void> {
  const { page, request, log, session } = context;
  const { channelUrl, maxVideos, includeShorts } = request.userData as ChannelUserData;

  log.info(`Scraping channel: ${channelUrl}`);

  try {
    await randomDelay();
    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!(window as unknown as { ytInitialData?: unknown }).ytInitialData, { timeout: 15000 }).catch(() => {});
    await randomDelay(800, 2000);

    // YouTube embeds all channel data in window.ytInitialData — far more reliable
    // than the volatile DOM selectors.
    const channelData = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const yt: any = (window as any).ytInitialData;
      const meta = yt?.metadata?.channelMetadataRenderer ?? {};
      const c4 = yt?.header?.c4TabbedHeaderRenderer ?? {};
      const ph = yt?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};

      const title: string | null = meta.title ?? c4.title ?? null;
      const description: string | null = meta.description ?? null;
      const handle: string | null =
        c4.channelHandleText?.runs?.[0]?.text ??
        (meta.vanityChannelUrl ? `@${String(meta.vanityChannelUrl).split('/@')[1] ?? ''}` : null);

      const avatarArr = meta.avatar?.thumbnails ?? c4.avatar?.thumbnails ?? [];
      const avatarUrl: string | null = avatarArr.length ? avatarArr[avatarArr.length - 1].url : null;
      const bannerArr = c4.banner?.thumbnails ?? [];
      const bannerUrl: string | null = bannerArr.length ? bannerArr[bannerArr.length - 1].url : null;

      let subscriberText: string | null = c4.subscriberCountText?.simpleText ?? null;
      let videoCountText: string | null = c4.videosCountText?.runs?.map((r: any) => r.text).join('') ?? null;

      // Newer page-header layout stores counts in metadata rows.
      if (!subscriberText || !videoCountText) {
        const rows = ph?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
        for (const row of rows) {
          for (const part of row.metadataParts ?? []) {
            const t: string = part.text?.content ?? '';
            if (/subscriber/i.test(t) && !subscriberText) subscriberText = t;
            else if (/video/i.test(t) && !videoCountText) videoCountText = t;
          }
        }
      }

      const headerBlob = JSON.stringify(c4.badges ?? []) + JSON.stringify(ph?.title ?? '');
      const isVerified = /verified|official artist/i.test(headerBlob);

      return { title, description, handle, avatarUrl, bannerUrl, subscriberText, videoCountText, isVerified };
    });

    const subscriberCountNumber = parseIntSafe(channelData.subscriberText);
    const totalVideoCountNumber = parseIntSafe(channelData.videoCountText);

    const channelRecord: ChannelRecord = {
      channelUrl,
      channelName: channelData.title,
      handle: channelData.handle,
      subscriberCount: channelData.subscriberText,
      subscriberCountNumber,
      totalViews: null,
      totalViewsNumber: null,
      totalVideoCount: channelData.videoCountText,
      totalVideoCountNumber,
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

    // Only push + charge when we actually identified the channel.
    if (!channelRecord.channelName && channelRecord.subscriberCountNumber === null) {
      log.warning(`No channel data extracted for ${channelUrl} (blocked or layout changed). Not saving or charging.`);
      session?.retire();
      throw new Error(`No channel data extracted for ${channelUrl}`);
    }

    await Actor.pushData(channelRecord);
    log.info(`Channel data pushed: ${channelRecord.channelName || channelUrl} (${channelRecord.subscriberCount ?? '?'} subs)`);

    try {
      await Actor.charge({ eventName: 'channel-scraped' });
      log.info('Charged event: channel-scraped');
    } catch (e) {
      log.warning(`PPE charge failed: ${e}`);
    }

    // Videos: parse the /videos tab ytInitialData grid (no per-video navigation).
    if ((maxVideos ?? 0) > 0) {
      const videosTabUrl = channelUrl.endsWith('/') ? `${channelUrl}videos` : `${channelUrl}/videos`;
      await page.goto(videosTabUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => !!(window as unknown as { ytInitialData?: unknown }).ytInitialData, { timeout: 15000 }).catch(() => {});
      await randomDelay(800, 1500);

      const videos = await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const yt: any = (window as any).ytInitialData;
        const out: Array<{ videoId: string; title: string | null; viewText: string | null; publishedText: string | null; lengthText: string | null; thumb: string | null }> = [];
        const seen = new Set<string>();

        const deepText = (obj: any, test: RegExp): string | null => {
          let result: string | null = null;
          const dig = (o: any): void => {
            if (result || !o || typeof o !== 'object') return;
            if (typeof o.text === 'string' && test.test(o.text)) { result = o.text; return; }
            if (typeof o.content === 'string' && test.test(o.content)) { result = o.content; return; }
            for (const k in o) dig(o[k]);
          };
          dig(obj);
          return result;
        };

        const walk = (obj: any): void => {
          if (!obj || typeof obj !== 'object') return;

          // Legacy videoRenderer
          const vr = obj.videoRenderer;
          if (vr?.videoId && !seen.has(vr.videoId)) {
            seen.add(vr.videoId);
            const thumbs = vr.thumbnail?.thumbnails ?? [];
            out.push({
              videoId: vr.videoId,
              title: vr.title?.runs?.[0]?.text ?? null,
              viewText: vr.viewCountText?.simpleText ?? (vr.viewCountText?.runs?.map((r: any) => r.text).join('') ?? null),
              publishedText: vr.publishedTimeText?.simpleText ?? null,
              lengthText: vr.lengthText?.simpleText ?? null,
              thumb: thumbs.length ? thumbs[thumbs.length - 1].url : null,
            });
          }

          // Newer lockupViewModel (current channel video grids)
          const lvm = obj.lockupViewModel;
          if (lvm?.contentId && /VIDEO/i.test(lvm.contentType ?? '') && !seen.has(lvm.contentId)) {
            seen.add(lvm.contentId);
            const md = lvm.metadata?.lockupMetadataViewModel;
            const title = md?.title?.content ?? null;
            const rows = md?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
            let viewText: string | null = null;
            let publishedText: string | null = null;
            for (const row of rows) {
              for (const part of row.metadataParts ?? []) {
                const t: string = part.text?.content ?? '';
                if (/view/i.test(t) && !viewText) viewText = t;
                else if (/(ago|stream|premiere)/i.test(t) && !publishedText) publishedText = t;
              }
            }
            const lengthText = deepText(lvm.contentImage, /^\d{1,2}:\d{2}(:\d{2})?$/);
            const sources = lvm.contentImage?.thumbnailViewModel?.image?.sources ?? [];
            out.push({
              videoId: lvm.contentId,
              title,
              viewText,
              publishedText,
              lengthText,
              thumb: sources.length ? sources[sources.length - 1].url : null,
            });
          }

          for (const k in obj) walk(obj[k]);
        };

        walk(yt);
        return out;
      });

      const limited = videos.slice(0, Math.min(maxVideos, 100));
      log.info(`Found ${limited.length} videos for ${channelRecord.channelName || channelUrl}`);

      for (const v of limited) {
        const durationSeconds = parseDurationToSeconds(v.lengthText);
        const videoRecord: VideoRecord = {
          channelUrl,
          channelName: channelRecord.channelName,
          videoUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
          videoTitle: v.title,
          viewCount: v.viewText,
          viewCountNumber: parseIntSafe(v.viewText),
          likeCount: null,
          likeCountNumber: null,
          commentCount: null,
          commentCountNumber: null,
          durationSeconds,
          durationFormatted: formatDuration(durationSeconds),
          publishedDate: v.publishedText,
          thumbnailUrl: v.thumb,
          videoDescription: null,
          tags: [],
          category: null,
          isShorts: false,
          scrapedAt: new Date().toISOString(),
        };
        if (!includeShorts && durationSeconds !== null && durationSeconds <= 60 && /short/i.test(v.lengthText ?? '')) continue;
        await Actor.pushData(videoRecord);
      }
    }

    session?.retire();
  } catch (error) {
    log.error(`Error scraping channel ${channelUrl}: ${error}`);
    session?.retire();
    throw error;
  }
}

async function scrapeVideo(
  context: PlaywrightCrawlingContext,
  videoUrl: string,
  channelUrl: string,
  channelName: string | null,
  isShort: boolean,
): Promise<void> {
  const { page, log } = context;

  try {
    await randomDelay();
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#info-text, ytd-video-primary-info-renderer, ytd-watch-metadata', { timeout: 15000 }).catch(() => {});
    await randomDelay(800, 2000);

    const videoData = await page.evaluate(() => {
      const getText = (sel: string): string | null => {
        const el = document.querySelector(sel);
        return el?.textContent?.trim() || null;
      };

      const getAttr = (sel: string, attr: string): string | null => {
        const el = document.querySelector(sel);
        return el?.getAttribute(attr) || null;
      };

      const title = getText('yt-formatted-string.style-scope.ytd-watch-metadata') ||
        document.querySelector('meta[name="title"]')?.getAttribute('content') ||
        getText('h1.title yt-formatted-string') || null;

      const viewText = getText('#info-text span') ||
        document.querySelector('meta[itemprop="interactionCount"]')?.getAttribute('content') ||
        getText('ytd-video-primary-info-renderer #info-text span:first-child') || null;

      const likeCountBtn = document.querySelector('#segmented-like-button button') ||
        document.querySelector('like-button-view-model button');
      const likeCountText = likeCountBtn?.getAttribute('aria-label') ||
        getText('#top-level-buttons-computed button button-text') ||
        getText('like-button-view-model button') || null;

      const commentCountText = getText('#count .count-text') ||
        getText('#count yt-formatted-string span') ||
        getText('ytd-comments-header-renderer #count yt-formatted-string') || null;

      const durationMeta = document.querySelector('meta[itemprop="duration"]')?.getAttribute('content') || null;
      const durationDisplay = getText('.ytp-time-duration') || null;
      const durationText = durationDisplay || durationMeta;

      const publishedText = getText('#info-strings yt-formatted-string') ||
        getText('ytd-video-primary-info-renderer #info-strings span') ||
        document.querySelector('meta[itemprop="uploadDate"]')?.getAttribute('content') ||
        document.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content') || null;

      const thumbnailUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;

      const description = getText('#description-inner, #description yt-formatted-string') ||
        document.querySelector('meta[name="description"]')?.getAttribute('content') || null;

      const tagElements = document.querySelectorAll('meta[name="keywords"]');
      const tags = tagElements.length > 0
        ? Array.from(tagElements).flatMap(m => (m.getAttribute('content') || '').split(',').map(t => t.trim())).filter(Boolean)
        : [];

      const category = document.querySelector('meta[itemprop="genre"]')?.getAttribute('content') || null;

      return {
        title,
        viewText,
        likeCountText,
        commentCountText,
        durationText,
        durationMeta,
        publishedText,
        thumbnailUrl,
        description,
        tags,
        category,
      };
    });

    let durationSeconds = parseDurationToSeconds(videoData.durationText);
    if (durationSeconds === null && videoData.durationMeta) {
      const match = videoData.durationMeta.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        const h = parseInt(match[1] || '0');
        const m = parseInt(match[2] || '0');
        const s = parseInt(match[3] || '0');
        durationSeconds = h * 3600 + m * 60 + s;
      }
    }

    const viewCountNumber = parseIntSafe(videoData.viewText);
    const likeCountNumber = extractNumber(videoData.likeCountText);
    const commentCountNumber = parseIntSafe(videoData.commentCountText);

    const videoRecord: VideoRecord = {
      channelUrl,
      channelName,
      videoUrl,
      videoTitle: videoData.title,
      viewCount: videoData.viewText || null,
      viewCountNumber,
      likeCount: videoData.likeCountText?.replace(/[^\d.KkMmBb,]/g, '') || null,
      likeCountNumber,
      commentCount: videoData.commentCountText || null,
      commentCountNumber,
      durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      publishedDate: videoData.publishedText || null,
      thumbnailUrl: videoData.thumbnailUrl,
      videoDescription: redactContactInfo(truncate(videoData.description, 500)),
      tags: videoData.tags,
      category: videoData.category,
      isShorts: isShort,
      scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(videoRecord);
    log.debug(`Video pushed: ${videoRecord.videoTitle || videoUrl}`);
  } catch (error) {
    log.warning(`Error scraping video ${videoUrl}: ${error}`);
  }
}

export async function searchHandler(context: PlaywrightCrawlingContext): Promise<void> {
  const { page, request, log, session } = context;
  const searchData = request.userData as SearchUserData;
  const { keyword, maxChannels } = searchData;

  log.info(`Searching YouTube for: ${keyword}`);

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%3D%3D`;
    await randomDelay();
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('ytd-video-renderer, ytd-channel-renderer', { timeout: 15000 }).catch(() => {});
    await randomDelay(1000, 2000);

    const channelUrls = await page.evaluate((max: number) => {
      const channels = new Set<string>();
      const channelRenderers = document.querySelectorAll('ytd-channel-renderer');
      const allRenderers = document.querySelectorAll('ytd-video-renderer, ytd-channel-renderer');

      for (const renderer of allRenderers) {
        if (channels.size >= max) break;
        const link = renderer.querySelector('a#main-link, a#avatar-button, a.yt-simple-endpoint');
        const href = link?.getAttribute('href');
        if (href && href.includes('/@')) {
          const cleanUrl = href.split('?')[0];
          channels.add(`https://www.youtube.com${cleanUrl}`);
        }
      }

      for (const renderer of channelRenderers) {
        if (channels.size >= max) break;
        const link = renderer.querySelector('a#main-link, a.yt-simple-endpoint');
        const href = link?.getAttribute('href');
        if (href && href.includes('/@')) {
          const cleanUrl = href.split('?')[0];
          channels.add(`https://www.youtube.com${cleanUrl}`);
        }
      }

      return Array.from(channels);
    }, maxChannels || 10);

    log.info(`Found ${channelUrls.length} channels from search: "${keyword}"`);

    for (const url of channelUrls) {
      await context.addRequests([{
        url,
        userData: {
          label: 'channel',
          channelUrl: url,
          maxVideos: searchData.maxVideosPerChannel,
          includeShorts: searchData.includeShorts,
        },
      }]);
    }

    session?.retire();
  } catch (error) {
    log.error(`Error searching for "${keyword}": ${error}`);
    session?.retire();
  }
}
