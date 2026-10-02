import { normalizeActorInput, normalizeYouTubeChannelUrl } from './run-config.js';
import { collectContentSection, type ContentCoverage } from './content-collector.js';
import type { ContentSection } from './content-pagination.js';
import { RequestBudget } from './request-budget.js';
import { transportLimitReason } from './bounded-http.js';
import { detailFailure, detailFailureDiagnostics } from './detail-failure.js';
import { evaluatePublicationWindow, observePublicationDate, type PublicationWindow } from './publication-window.js';
import type {
  ActorInput,
  ChannelRecord,
  CommunityPostRecord,
  PlaylistRecord,
  SocialProfiles,
  VideoRecord,
} from './types.js';
import {
  extractChannelAbout,
  extractChannelMetadata,
  extractCommunityPosts,
  extractPlaylists,
  extractSearchChannelUrls,
  extractVideoDetails,
  extractVideos,
  publicVideoId,
  type YouTubePage,
} from './youtube-http.js';
import {
  buildPublicChannelLinks,
  formatDuration,
  parseCompactCount,
  parseDurationToSeconds,
  redactContactInfo,
  truncate,
} from './youtube-utils.js';

export const CHANNEL_SCRAPED_EVENT = 'channel-scraped';

type ContentRecord = VideoRecord | PlaylistRecord | CommunityPostRecord;
type Logger = { info(message: string): void; warning(message: string): void; error(message: string): void; debug(message: string): void };

export interface RunServices {
  fetchPage(url: string, budget: RequestBudget): Promise<YouTubePage>;
  fetchPlayer(videoId: string, html: string, budget: RequestBudget): Promise<Record<string, any>>;
  fetchContinuation(token: string, html: string, budget: RequestBudget): Promise<Record<string, any>>;
  saveChannel(record: ChannelRecord): Promise<{ chargedCount: number; eventChargeLimitReached: boolean }>;
  saveRows(records: ContentRecord[]): Promise<unknown>;
  saveSummary(summary: RunSummary): Promise<unknown>;
  log: Logger;
  now?: () => number;
}

export interface SectionReport extends ContentCoverage {
  rowsSaved: number;
  dateFilterApplied: boolean;
}

export interface ChannelReport {
  channelUrl: string;
  channelSaved: boolean;
  status: 'pending' | 'saved' | 'failed' | 'duplicate' | 'charge-limit';
  requestsUsed: number;
  detailedRequestsFailed: number;
  /** Fixed categories only; no source bodies, errors, keys or continuation tokens. */
  detailedFailures: ({ stage: 'channel-about' | 'video-page' | 'player' } & ReturnType<typeof detailFailureDiagnostics>)[];
  sections: Partial<Record<ContentSection, SectionReport>>;
}

export interface RunSummary {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  complete: boolean;
  spendingLimitReached: boolean;
  savedChannelCount: number;
  savedVideoCount: number;
  failedRequestCount: number;
  detailedRequestFailureCount: number;
  publicationWindow: PublicationWindow;
  limits: { maxPagesPerSection: number; maxRequestsPerChannel: number; channelDeadlineSeconds: number };
  channels: ChannelReport[];
}

export async function runYouTube(input: ActorInput, services: RunServices): Promise<RunSummary> {
  const normalized = normalizeActorInput(input);
  const { log } = services;
  const now = services.now ?? Date.now;
  const summary: RunSummary = {
    schemaVersion: 1, startedAt: new Date(now()).toISOString(), finishedAt: null,
    status: 'running', complete: false, spendingLimitReached: false,
    savedChannelCount: 0, savedVideoCount: 0, failedRequestCount: 0, detailedRequestFailureCount: 0,
    publicationWindow: { publishedAfter: normalized.publishedAfter, publishedBefore: normalized.publishedBefore },
    limits: { maxPagesPerSection: normalized.maxPagesPerSection, maxRequestsPerChannel: normalized.maxRequestsPerChannel, channelDeadlineSeconds: 240 },
    channels: [],
  };
  let fatalError: Error | null = null;
  let confirmedEmptySearchCount = 0;
  let failedRequestCount = 0;
  let detailedRequestFailureCount = 0;
  let savedChannelCount = 0;
  let savedVideoCount = 0;
  let spendingLimitReached = false;
  try {
    const channelBudget = normalized.maxRequestsPerCrawl - normalized.searchKeywords.length;
    const channelQueue = [...normalized.channelUrls];
    const queuedUrls = new Set(channelQueue.map((url) => url.toLowerCase()));

    for (const keyword of normalized.searchKeywords) {
      if (channelQueue.length >= channelBudget) break;
      try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%3D%3D`;
        const page = await services.fetchPage(searchUrl, new RequestBudget(4, 120_000, now));
        const discovered = extractSearchChannelUrls(page.initialData, normalized.maxChannels);
        if (discovered.length === 0) {
          const serialized = JSON.stringify(page.initialData);
          if (!/No results found|No channels found|No results/i.test(serialized)) {
            throw new Error('Search returned no verified channel matches or explicit empty message.');
          }
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
        log.error('YouTube channel search failed; no empty result is inferred from the failure.');
      }
    }

    const savedChannelKeys = new Set<string>();
    for (const channelUrl of channelQueue.slice(0, channelBudget)) {
      if (spendingLimitReached) break;
      const budget = new RequestBudget(normalized.maxRequestsPerChannel, 240_000, now);
      const report: ChannelReport = {
        channelUrl, channelSaved: false, status: 'pending', requestsUsed: 0, detailedRequestsFailed: 0,
        detailedFailures: [], sections: {},
      };
      summary.channels.push(report);
      try {
        const pageUrl = normalized.maxVideosPerChannel > 0
          ? `${channelUrl.replace(/\/$/, '')}/videos`
          : channelUrl;
        const page = await services.fetchPage(pageUrl, budget);
        const metadata = extractChannelMetadata(page.initialData);
        if (!metadata.title && parseCompactCount(metadata.subscriberText) === null) {
          throw new Error('No channel metadata was found in YouTube initial data');
        }
        const requestedId = new URL(channelUrl).pathname.match(/^\/channel\/([^/]+)$/)?.[1];
        if (requestedId && metadata.externalId && requestedId !== metadata.externalId) {
          throw new Error('The returned channel identity did not match the requested ID.');
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
          report.status = 'duplicate';
          log.info(`Skipping duplicate YouTube channel: ${canonicalChannelUrl}`);
          continue;
        }

        let about: ReturnType<typeof extractChannelAbout> = null;
        if (normalized.mode === 'detailed') {
          try {
            const aboutPage = await services.fetchPage(
              `${canonicalChannelUrl.replace(/\/$/, '')}/about`,
              budget,
            );
            const aboutMetadata = extractChannelMetadata(aboutPage.initialData);
            if (metadata.externalId && aboutMetadata.externalId && metadata.externalId !== aboutMetadata.externalId) {
              throw new Error('About page belongs to a different channel.');
            }
            const candidateAbout = extractChannelAbout(aboutPage.initialData);
            if (!candidateAbout) throw new Error('YouTube About metadata was not found');
            if (candidateAbout.canonicalUrl) {
              const candidateUrl = normalizeYouTubeChannelUrl(candidateAbout.canonicalUrl);
              const candidateId = new URL(candidateUrl).pathname.match(/^\/channel\/([^/]+)$/)?.[1];
              if (candidateId && metadata.externalId && candidateId !== metadata.externalId) {
                throw new Error('About canonical channel ID did not match.');
              }
              // About fields may supplement the identified channel, never redirect its feeds.
            }
            about = candidateAbout;
          } catch (error) {
            report.detailedRequestsFailed += 1;
            detailedRequestFailureCount += 1;
            report.detailedFailures.push({ stage: 'channel-about', ...detailFailureDiagnostics(error) });
            log.warning(`Detailed channel fields were unavailable for ${canonicalChannelUrl}.`);
          }
        }

        const subscriberText = about?.subscriberText ?? metadata.subscriberText;
        const videoCountText = about?.videoCountText ?? metadata.videoCountText;
        const publicChannelLinks = buildPublicChannelLinks(canonicalChannelUrl, metadata.externalId);
        const emptySocialProfiles: SocialProfiles = {
          facebook: [],
          instagram: [],
          linkedin: [],
          x: [],
          youtube: [],
          tiktok: [],
          reddit: [],
          twitch: [],
          threads: [],
          discord: [],
        };

        const channelRecord: ChannelRecord = {
          recordType: 'channel',
          channelUrl: canonicalChannelUrl,
          channelId: metadata.externalId,
          canonicalChannelUrl,
          ...publicChannelLinks,
          channelName: metadata.title,
          handle: metadata.handle,
          subscriberCount: subscriberText,
          subscriberCountNumber: parseCompactCount(subscriberText),
          totalViews: about?.totalViewsText ?? null,
          totalViewsNumber: parseCompactCount(about?.totalViewsText ?? null),
          totalVideoCount: videoCountText,
          totalVideoCountNumber: parseCompactCount(videoCountText),
          joinDate: about?.joinDate ?? null,
          country: about?.country ?? null,
          channelDescription: redactContactInfo(truncate(about?.description ?? metadata.description, 5000)),
          avatarImageUrl: metadata.avatarUrl,
          bannerImageUrl: metadata.bannerUrl,
          channelCategory: null,
          isVerified: metadata.isVerified,
          socialLinks: about?.socialLinks ?? [],
          socialProfiles: about?.socialProfiles ?? emptySocialProfiles,
          websiteLinks: about?.websiteLinks ?? [],
          externalLinks: about?.externalLinks ?? [],
          scrapedAt: new Date(now()).toISOString(),
        };

        const chargeResult = await services.saveChannel(channelRecord).catch((error) => {
          throw Object.assign(new Error('Channel dataset write failed.'), { datasetWrite: true });
        });
        const recordWasSaved = chargeResult.chargedCount > 0 || !chargeResult.eventChargeLimitReached;
        if (!recordWasSaved) {
          spendingLimitReached = true;
          report.status = 'charge-limit';
          log.warning(`Charge limit reached for ${CHANNEL_SCRAPED_EVENT}; the channel was not saved.`);
          break;
        }

        savedChannelKeys.add(channelKey);
        savedChannelCount += 1;
        report.channelUrl = canonicalChannelUrl;
        report.channelSaved = true;
        report.status = 'saved';
        // Finish a successfully saved current channel even when it filled the charge cap.
        spendingLimitReached = chargeResult.eventChargeLimitReached;
        const collect = async <T extends ContentRecord>(
          section: ContentSection, url: string, maxRows: number,
          mapItems: (items: Record<string, any>[]) => T[], key: (row: T) => string,
          initialPage?: YouTubePage,
        ): Promise<T[]> => {
          try {
            const sectionPage = initialPage ?? await services.fetchPage(url, budget);
            const collected = await collectContentSection({
              section, initialData: sectionPage.initialData, expectedChannelId: metadata.externalId,
              maxPages: normalized.maxPagesPerSection, maxRows,
              fetchContinuation: (token) => services.fetchContinuation(token, sectionPage.html, budget),
              mapItems, key,
              accept: section === 'playlists' ? undefined : (row) => {
                const match = (row as VideoRecord | CommunityPostRecord).publicationWindowMatch;
                return match === 'outside-window' ? 'exclude' : match === 'uncertain' ? 'uncertain' : 'include';
              },
            });
            report.sections[section] = {
              ...collected.coverage, rowsSaved: 0,
              dateFilterApplied: section !== 'playlists' && !!(normalized.publishedAfter || normalized.publishedBefore),
            };
            return collected.rows;
          } catch (error) {
            const reason = transportLimitReason(error);
            report.sections[section] = failedSection(section, reason, summary.publicationWindow);
            log.warning(`Public ${section} content was unavailable for ${canonicalChannelUrl}; coverage is incomplete.`);
            return [];
          }
        };
        const mapVideos = (contentType: VideoRecord['contentType']) => (items: Record<string, any>[]) =>
          buildVideoRecords({ contents: items }, canonicalChannelUrl, metadata.title, contentType, summary.publicationWindow, new Date(now()).toISOString());
        const videoRecords = await collect('videos', publicChannelLinks.videosUrl, normalized.maxVideosPerChannel,
          mapVideos('video'), (row) => row.videoId, page);

        if (normalized.includeShorts) {
          videoRecords.push(...await collect('shorts', publicChannelLinks.shortsUrl, normalized.maxShortsPerChannel,
            mapVideos('short'), (row) => row.videoId));
        }

        if (normalized.includeLiveStreams) {
          videoRecords.push(...await collect('streams', publicChannelLinks.liveStreamsUrl, normalized.maxLiveStreamsPerChannel,
            mapVideos('live_stream'), (row) => row.videoId));
        }

        let uniqueVideoRecords = [...new Map(videoRecords.map((record) => [
          `${record.contentType}:${record.videoId}`,
          record,
        ])).values()];

        if (normalized.mode === 'detailed' && normalized.maxDetailedVideosPerChannel > 0) {
          const detailLimit = Math.min(normalized.maxDetailedVideosPerChannel, uniqueVideoRecords.length);
          for (let index = 0; index < detailLimit; index += 1) {
            const record = uniqueVideoRecords[index];
            try {
              const detailPage = await services.fetchPage(record.videoUrl, budget);
              const returnedId = publicVideoId(detailPage.finalUrl);
              if (returnedId && returnedId !== record.videoId) {
                throw detailFailure('Video detail page identity mismatch.', 'video-identity-mismatch');
              }
              let detail = extractVideoDetails(detailPage.initialData, detailPage.html, undefined, record.videoId);
              const hasExactPublishDate = observePublicationDate(null, record.scrapedAt, detail.publishedDate).publishedAtPrecision === 'exact';
              if (!detail.category || detail.tags.length === 0 || !hasExactPublishDate) {
                try {
                  const videoId = publicVideoId(record.videoUrl);
                  if (!videoId) throw new Error(`Video ID was not found in ${record.videoUrl}`);
                  const playerData = await services.fetchPlayer(
                    videoId,
                    detailPage.html,
                    budget,
                  );
                  detail = extractVideoDetails(detailPage.initialData, detailPage.html, playerData, record.videoId);
                } catch (error) {
                  report.detailedRequestsFailed += 1;
                  detailedRequestFailureCount += 1;
                  report.detailedFailures.push({ stage: 'player', ...detailFailureDiagnostics(error) });
                  log.warning(
                    `Optional player metadata was unavailable for ${record.videoUrl}; `
                    + 'keeping the video-page fields.',
                  );
                }
              }
              const durationSeconds = detail.durationSeconds ?? record.durationSeconds;
              const publication = observePublicationDate(record.sourceDateText, record.scrapedAt, detail.publishedDate);
              uniqueVideoRecords[index] = {
                ...record,
                videoTitle: detail.title ?? record.videoTitle,
                viewCount: detail.viewCount ?? record.viewCount,
                viewCountNumber: parseCompactCount(detail.viewCount) ?? record.viewCountNumber,
                likeCount: detail.likeCount,
                likeCountNumber: detail.likeCountNumber,
                commentCount: detail.commentCount,
                commentCountNumber: detail.commentCountNumber,
                durationSeconds,
                durationFormatted: formatDuration(durationSeconds),
                publishedDate: detail.publishedDate ?? record.publishedDate,
                ...publication,
                publicationWindowMatch: evaluatePublicationWindow(publication, summary.publicationWindow),
                thumbnailUrl: detail.thumbnailUrl ?? record.thumbnailUrl,
                videoDescription: redactContactInfo(truncate(detail.description, 5000)),
                tags: detail.tags,
                category: detail.category,
              };
            } catch (error) {
              report.detailedRequestsFailed += 1;
              detailedRequestFailureCount += 1;
              report.detailedFailures.push({ stage: 'video-page', ...detailFailureDiagnostics(error) });
              log.warning(`Detailed video fields were unavailable for ${record.videoUrl}.`);
            }
          }
        }

        for (const [section, contentType] of [['videos', 'video'], ['shorts', 'short'], ['streams', 'live_stream']] as const) {
          const coverage = report.sections[section];
          if (!coverage) continue;
          const rows = uniqueVideoRecords.filter((row) => row.contentType === contentType);
          coverage.filteredRows += rows.filter((row) => row.publicationWindowMatch === 'outside-window').length;
          coverage.rowsSelected = rows.filter((row) => row.publicationWindowMatch !== 'outside-window').length;
          coverage.uncertainRows = rows.filter((row) => row.publicationWindowMatch === 'uncertain').length;
          coverage.complete = ['empty', 'exhausted'].includes(coverage.status) && coverage.uncertainRows === 0;
        }
        uniqueVideoRecords = uniqueVideoRecords.filter((row) => row.publicationWindowMatch !== 'outside-window');

        if (uniqueVideoRecords.length > 0) {
          await services.saveRows(uniqueVideoRecords).catch(() => {
            throw Object.assign(new Error('Video dataset write failed.'), { datasetWrite: true });
          });
          savedVideoCount += uniqueVideoRecords.length;
        }
        for (const [section, contentType] of [['videos', 'video'], ['shorts', 'short'], ['streams', 'live_stream']] as const) {
          if (report.sections[section]) report.sections[section]!.rowsSaved = uniqueVideoRecords.filter((row) => row.contentType === contentType).length;
        }

        let playlistRecords: PlaylistRecord[] = [];
        if (normalized.includePlaylists) {
          playlistRecords = await collect('playlists', publicChannelLinks.playlistsUrl, normalized.maxPlaylistsPerChannel,
            (items) => extractPlaylists({ contents: items }).map((playlist): PlaylistRecord => ({
              recordType: 'playlist', channelUrl: canonicalChannelUrl, channelName: metadata.title,
              playlistId: playlist.playlistId,
              playlistUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.playlistId)}`,
              playlistTitle: playlist.title, videoCount: playlist.videoCountText,
              videoCountNumber: parseCompactCount(playlist.videoCountText), thumbnailUrl: playlist.thumbnailUrl,
              scrapedAt: new Date(now()).toISOString(),
            })), (row) => row.playlistId);
          if (playlistRecords.length > 0) await services.saveRows(playlistRecords).catch(() => {
            throw Object.assign(new Error('Playlist dataset write failed.'), { datasetWrite: true });
          });
          report.sections.playlists!.rowsSaved = playlistRecords.length;
        }

        let communityRecords: CommunityPostRecord[] = [];
        if (normalized.includeCommunityPosts) {
          communityRecords = await collect('community', publicChannelLinks.communityUrl, normalized.maxCommunityPostsPerChannel,
            (items) => extractCommunityPosts({ contents: items }).map((post): CommunityPostRecord => {
              const scrapedAt = new Date(now()).toISOString();
              const publication = observePublicationDate(post.publishedText, scrapedAt);
              return {
                recordType: 'community_post', channelUrl: canonicalChannelUrl, channelName: metadata.title,
                postId: post.postId, postUrl: `https://www.youtube.com/post/${encodeURIComponent(post.postId)}`,
                postText: redactContactInfo(truncate(post.text, 5000)), publishedDate: post.publishedText,
                ...publication, publicationWindowMatch: evaluatePublicationWindow(publication, summary.publicationWindow),
                likeCount: post.likeCountText, likeCountNumber: parseCompactCount(post.likeCountText),
                commentCount: post.commentCountText, commentCountNumber: parseCompactCount(post.commentCountText),
                attachmentType: post.attachmentType, attachmentUrl: post.attachmentUrl, imageUrl: post.imageUrl, scrapedAt,
              };
            }), (row) => row.postId);
          if (communityRecords.length > 0) await services.saveRows(communityRecords).catch(() => {
            throw Object.assign(new Error('Community dataset write failed.'), { datasetWrite: true });
          });
          report.sections.community!.rowsSaved = communityRecords.length;
        }
        log.info(
          `Saved ${metadata.title ?? canonicalChannelUrl} with ${uniqueVideoRecords.length} video/Short/live row(s), `
          + `${playlistRecords.length} playlist row(s), and ${communityRecords.length} community-post row(s).`,
        );

        if (chargeResult.eventChargeLimitReached) spendingLimitReached = true;
      } catch (error) {
        failedRequestCount += 1;
        report.status = 'failed';
        for (const coverage of Object.values(report.sections)) coverage.complete = false;
        log.error(`YouTube channel work failed for ${channelUrl}; see incomplete coverage in RUN-SUMMARY.`);
        if ((error as any)?.datasetWrite) throw error;
      } finally {
        report.requestsUsed = budget.used;
        for (const section of [
          'videos', ...(normalized.includeShorts ? ['shorts'] : []),
          ...(normalized.includeLiveStreams ? ['streams'] : []),
          ...(normalized.includePlaylists ? ['playlists'] : []),
          ...(normalized.includeCommunityPosts ? ['community'] : []),
        ] as ContentSection[]) {
          if (!report.sections[section]) report.sections[section] = failedSection(section, null, summary.publicationWindow);
        }
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
    log.info(
      `Run complete in ${normalized.mode} mode. Saved channel rows: ${savedChannelCount}. `
      + `Saved video rows: ${savedVideoCount}. Failed channel/search requests: ${failedRequestCount}. `
      + `Detailed-field request failures: ${detailedRequestFailureCount}.`,
    );
  } catch (error) {
    fatalError = error instanceof Error ? error : new Error('YouTube run failed.');
  } finally {
    summary.finishedAt = new Date(now()).toISOString();
    summary.status = fatalError ? 'failed' : 'succeeded';
    summary.spendingLimitReached = spendingLimitReached;
    summary.savedChannelCount = savedChannelCount;
    summary.savedVideoCount = savedVideoCount;
    summary.failedRequestCount = failedRequestCount;
    summary.detailedRequestFailureCount = detailedRequestFailureCount;
    summary.complete = !fatalError && !spendingLimitReached && failedRequestCount === 0
      && summary.channels.every((channel) => channel.status === 'duplicate'
        || (channel.channelSaved && channel.detailedRequestsFailed === 0
          && Object.values(channel.sections).every((section) => section.complete)));
    await services.saveSummary(summary);
  }
  if (fatalError) throw fatalError;
  return summary;
}

function buildVideoRecords(
  initialData: Record<string, any>,
  channelUrl: string,
  channelName: string | null,
  contentType: VideoRecord['contentType'],
  window: PublicationWindow,
  scrapedAt: string,
): VideoRecord[] {
  return extractVideos(initialData)
    .map((video): VideoRecord => {
      const durationSeconds = parseDurationToSeconds(video.lengthText);
      // The selected tab is stronger evidence than duration (ordinary videos can be short).
      const isShorts = contentType === 'short' || /\/shorts\//.test(video.navigationUrl ?? '');
      const publication = observePublicationDate(video.publishedText, scrapedAt);
      return {
        recordType: 'video',
        contentType,
        videoId: video.videoId,
        channelUrl,
        channelName,
        videoUrl: contentType === 'short'
          ? `https://www.youtube.com/shorts/${video.videoId}`
          : `https://www.youtube.com/watch?v=${video.videoId}`,
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
        ...publication,
        publicationWindowMatch: evaluatePublicationWindow(publication, window),
        thumbnailUrl: video.thumbnailUrl,
        videoDescription: null,
        tags: [],
        category: null,
        isShorts: contentType === 'short' || isShorts,
        liveStatus: contentType === 'live_stream' ? video.liveStatus : null,
        scrapedAt,
      };
    })
    .filter((video) => contentType !== 'video' || !video.isShorts);
}

function failedSection(section: ContentSection, reason: string | null, window: PublicationWindow): SectionReport {
  return {
    section, status: reason === 'request-limit' || reason === 'time-limit' ? reason : 'failed',
    complete: false, pagesFetched: 0, rowsSeen: 0, duplicateRows: 0, filteredRows: 0, uncertainRows: 0,
    rowsSelected: 0, rowsSaved: 0, morePagesAvailable: null, selectedTabVerified: false,
    errorCategory: reason ?? 'section-unavailable',
    dateFilterApplied: section !== 'playlists' && !!(window.publishedAfter || window.publishedBefore),
  };
}
