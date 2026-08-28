import { Actor, log } from 'apify';

import { normalizeActorInput, normalizeYouTubeChannelUrl } from './run-config.js';
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
  fetchYouTubePage,
  fetchYouTubePlayerData,
} from './youtube-http.js';
import {
  buildPublicChannelLinks,
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
  let detailedRequestFailureCount = 0;
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

      let about: ReturnType<typeof extractChannelAbout> = null;
      if (normalized.mode === 'detailed') {
        try {
          const aboutPage = await fetchYouTubePage(
            `${canonicalChannelUrl.replace(/\/$/, '')}/about`,
            proxyConfiguration,
          );
          about = extractChannelAbout(aboutPage.initialData);
          if (!about) throw new Error('YouTube About metadata was not found');
          if (about.canonicalUrl) {
            try {
              canonicalChannelUrl = normalizeYouTubeChannelUrl(about.canonicalUrl);
            } catch {
              log.debug(`Ignoring malformed About-page channel URL: ${about.canonicalUrl}`);
            }
          }
        } catch (error) {
          detailedRequestFailureCount += 1;
          log.warning(`Detailed channel fields were unavailable for ${canonicalChannelUrl}: ${String(error)}`);
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
        'video',
      );

      if (normalized.includeShorts) {
        try {
          const shortsPage = await fetchYouTubePage(publicChannelLinks.shortsUrl, proxyConfiguration);
          videoRecords.push(...buildVideoRecords(
            shortsPage.initialData,
            canonicalChannelUrl,
            metadata.title,
            normalized.maxShortsPerChannel,
            'short',
          ));
        } catch (error) {
          detailedRequestFailureCount += 1;
          log.warning(`Shorts were unavailable for ${canonicalChannelUrl}: ${String(error)}`);
        }
      }

      if (normalized.includeLiveStreams) {
        try {
          const streamsPage = await fetchYouTubePage(publicChannelLinks.liveStreamsUrl, proxyConfiguration);
          videoRecords.push(...buildVideoRecords(
            streamsPage.initialData,
            canonicalChannelUrl,
            metadata.title,
            normalized.maxLiveStreamsPerChannel,
            'live_stream',
          ));
        } catch (error) {
          detailedRequestFailureCount += 1;
          log.warning(`Live streams were unavailable for ${canonicalChannelUrl}: ${String(error)}`);
        }
      }

      const uniqueVideoRecords = [...new Map(videoRecords.map((record) => [
        `${record.contentType}:${record.videoId}`,
        record,
      ])).values()];

      if (normalized.mode === 'detailed' && normalized.maxDetailedVideosPerChannel > 0) {
        const detailLimit = Math.min(normalized.maxDetailedVideosPerChannel, uniqueVideoRecords.length);
        for (let index = 0; index < detailLimit; index += 1) {
          const record = uniqueVideoRecords[index];
          try {
            const detailPage = await fetchYouTubePage(record.videoUrl, proxyConfiguration);
            let detail = extractVideoDetails(detailPage.initialData, detailPage.html);
            const hasExactPublishDate = /^\d{4}-\d{2}-\d{2}/.test(detail.publishedDate ?? '');
            if (!detail.category || detail.tags.length === 0 || !hasExactPublishDate) {
              try {
                const parsedVideoUrl = new URL(record.videoUrl);
                const videoId = parsedVideoUrl.searchParams.get('v')
                  ?? parsedVideoUrl.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1]
                  ?? null;
                if (!videoId) throw new Error(`Video ID was not found in ${record.videoUrl}`);
                const playerData = await fetchYouTubePlayerData(
                  videoId,
                  detailPage.html,
                  proxyConfiguration,
                  1,
                );
                detail = extractVideoDetails(detailPage.initialData, detailPage.html, playerData);
              } catch (error) {
                detailedRequestFailureCount += 1;
                log.warning(
                  `Optional player metadata was unavailable for ${record.videoUrl}; `
                  + `keeping the video-page fields. ${String(error)}`,
                );
              }
            }
            const durationSeconds = detail.durationSeconds ?? record.durationSeconds;
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
              thumbnailUrl: detail.thumbnailUrl ?? record.thumbnailUrl,
              videoDescription: redactContactInfo(truncate(detail.description, 5000)),
              tags: detail.tags,
              category: detail.category,
            };
          } catch (error) {
            detailedRequestFailureCount += 1;
            log.warning(`Detailed video fields were unavailable for ${record.videoUrl}: ${String(error)}`);
          }
        }
      }

      if (uniqueVideoRecords.length > 0) {
        await Actor.pushData(uniqueVideoRecords);
        savedVideoCount += uniqueVideoRecords.length;
      }

      let playlistRecords: PlaylistRecord[] = [];
      if (normalized.includePlaylists) {
        try {
          const playlistsPage = await fetchYouTubePage(publicChannelLinks.playlistsUrl, proxyConfiguration);
          playlistRecords = extractPlaylists(playlistsPage.initialData)
            .slice(0, normalized.maxPlaylistsPerChannel)
            .map((playlist): PlaylistRecord => ({
              recordType: 'playlist',
              channelUrl: canonicalChannelUrl,
              channelName: metadata.title,
              playlistId: playlist.playlistId,
              playlistUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.playlistId)}`,
              playlistTitle: playlist.title,
              videoCount: playlist.videoCountText,
              videoCountNumber: parseCompactCount(playlist.videoCountText),
              thumbnailUrl: playlist.thumbnailUrl,
              scrapedAt: new Date().toISOString(),
            }));
          if (playlistRecords.length > 0) await Actor.pushData(playlistRecords);
        } catch (error) {
          detailedRequestFailureCount += 1;
          log.warning(`Playlists were unavailable for ${canonicalChannelUrl}: ${String(error)}`);
        }
      }

      let communityRecords: CommunityPostRecord[] = [];
      if (normalized.includeCommunityPosts) {
        try {
          const communityPage = await fetchYouTubePage(publicChannelLinks.communityUrl, proxyConfiguration);
          communityRecords = extractCommunityPosts(communityPage.initialData)
            .slice(0, normalized.maxCommunityPostsPerChannel)
            .map((post): CommunityPostRecord => ({
              recordType: 'community_post',
              channelUrl: canonicalChannelUrl,
              channelName: metadata.title,
              postId: post.postId,
              postUrl: `https://www.youtube.com/post/${encodeURIComponent(post.postId)}`,
              postText: redactContactInfo(truncate(post.text, 5000)),
              publishedDate: post.publishedText,
              likeCount: post.likeCountText,
              likeCountNumber: parseCompactCount(post.likeCountText),
              commentCount: post.commentCountText,
              commentCountNumber: parseCompactCount(post.commentCountText),
              attachmentType: post.attachmentType,
              attachmentUrl: post.attachmentUrl,
              imageUrl: post.imageUrl,
              scrapedAt: new Date().toISOString(),
            }));
          if (communityRecords.length > 0) await Actor.pushData(communityRecords);
        } catch (error) {
          detailedRequestFailureCount += 1;
          log.warning(`Community posts were unavailable for ${canonicalChannelUrl}: ${String(error)}`);
        }
      }

      log.info(
        `Saved ${metadata.title ?? canonicalChannelUrl} with ${uniqueVideoRecords.length} video/Short/live row(s), `
        + `${playlistRecords.length} playlist row(s), and ${communityRecords.length} community-post row(s).`,
      );

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
  log.info(
    `Run complete in ${normalized.mode} mode. Saved channel rows: ${savedChannelCount}. `
    + `Saved video rows: ${savedVideoCount}. Failed channel/search requests: ${failedRequestCount}. `
    + `Detailed-field request failures: ${detailedRequestFailureCount}.`,
  );
} catch (error) {
  await Actor.fail(error instanceof Error ? error.message : String(error));
}

await Actor.exit();

function buildVideoRecords(
  initialData: Record<string, any>,
  channelUrl: string,
  channelName: string | null,
  maximum: number,
  contentType: VideoRecord['contentType'],
): VideoRecord[] {
  return extractVideos(initialData)
    .map((video): VideoRecord => {
      const durationSeconds = parseDurationToSeconds(video.lengthText);
      const isShorts = detectShorts(video.navigationUrl, durationSeconds);
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
        thumbnailUrl: video.thumbnailUrl,
        videoDescription: null,
        tags: [],
        category: null,
        isShorts: contentType === 'short' || isShorts,
        liveStatus: contentType === 'live_stream' ? video.liveStatus : null,
        scrapedAt: new Date().toISOString(),
      };
    })
    .filter((video) => contentType === 'short' ? video.isShorts : !video.isShorts)
    .slice(0, maximum);
}
