import type { ProxyConfiguration } from 'apify';
import { gotScraping } from 'crawlee';

import { classifyYouTubeDocument } from './youtube-utils.js';
import type { ChannelExternalLink, ExternalLinkPlatform, SocialProfiles } from './types.js';

type JsonObject = Record<string, any>;

export interface YouTubePage {
  initialData: JsonObject;
  html: string;
  finalUrl: string;
}

export interface ChannelAboutMetadata {
  subscriberText: string | null;
  videoCountText: string | null;
  totalViewsText: string | null;
  joinDate: string | null;
  country: string | null;
  description: string | null;
  socialLinks: string[];
  socialProfiles: SocialProfiles;
  websiteLinks: string[];
  externalLinks: ChannelExternalLink[];
  canonicalUrl: string | null;
}

export interface VideoDetailMetadata {
  title: string | null;
  viewCount: string | null;
  likeCount: string | null;
  likeCountNumber: number | null;
  commentCount: string | null;
  commentCountNumber: number | null;
  durationSeconds: number | null;
  publishedDate: string | null;
  thumbnailUrl: string | null;
  description: string | null;
  tags: string[];
  category: string | null;
}

export interface PlaylistMetadata {
  playlistId: string;
  title: string | null;
  videoCountText: string | null;
  thumbnailUrl: string | null;
}

export interface CommunityPostMetadata {
  postId: string;
  text: string | null;
  publishedText: string | null;
  likeCountText: string | null;
  commentCountText: string | null;
  attachmentType: 'image' | 'video' | 'playlist' | 'poll' | 'none';
  attachmentUrl: string | null;
  imageUrl: string | null;
}

export interface YouTubePlayerApiConfig {
  apiKey: string;
  clientVersion: string;
}

const REQUEST_HEADERS = {
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  cookie: 'SOCS=CAI',
};

export async function fetchYouTubePage(
  url: string,
  proxyConfiguration?: ProxyConfiguration,
  maximumAttempts = 4,
): Promise<YouTubePage> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const proxyUrl = proxyConfiguration
        ? await proxyConfiguration.newUrl(`youtube-http-${attempt}-${Date.now()}`)
        : undefined;
      const response = await gotScraping({
        url,
        proxyUrl,
        headers: REQUEST_HEADERS,
        timeout: { request: 30_000 },
        retry: { limit: 0 },
        throwHttpErrors: false,
        followRedirect: true,
      });

      const html = String(response.body);
      const title = readHtmlTitle(html);
      const state = classifyYouTubeDocument(title, stripMarkup(html).slice(0, 80_000), false);

      if (response.statusCode >= 400) throw new Error(`YouTube returned HTTP ${response.statusCode}`);
      if (state === 'blocked') throw new Error('YouTube blocked the request');
      if (state === 'unavailable') throw new Error('YouTube page is unavailable');

      return {
        initialData: extractInitialData(html),
        html,
        finalUrl: response.url,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maximumAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }

  throw new Error(`YouTube request failed after ${maximumAttempts} attempts: ${lastError?.message ?? 'unknown error'}`);
}

export async function fetchYouTubePlayerData(
  videoId: string,
  sourceHtml: string,
  proxyConfiguration?: ProxyConfiguration,
  maximumAttempts = 3,
): Promise<JsonObject> {
  const config = extractPlayerApiConfig(sourceHtml);
  if (!config) throw new Error('YouTube public player API configuration was not found');

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const proxyUrl = proxyConfiguration
        ? await proxyConfiguration.newUrl(`youtube-player-${attempt}-${Date.now()}`)
        : undefined;
      const response = await gotScraping({
        url: `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}`,
        method: 'POST',
        proxyUrl,
        headers: {
          ...REQUEST_HEADERS,
          'content-type': 'application/json',
          origin: 'https://www.youtube.com',
          'x-youtube-client-name': '1',
          'x-youtube-client-version': config.clientVersion,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: config.clientVersion,
              hl: 'en',
              gl: 'US',
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        timeout: { request: 30_000 },
        retry: { limit: 0 },
        throwHttpErrors: false,
      });

      if (response.statusCode >= 400) throw new Error(`YouTube player API returned HTTP ${response.statusCode}`);
      const data = JSON.parse(String(response.body)) as JsonObject;
      if (!data.videoDetails && !data.microformat?.playerMicroformatRenderer) {
        throw new Error('YouTube player API returned no public video metadata');
      }
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maximumAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }

  throw new Error(
    `YouTube player metadata request failed after ${maximumAttempts} attempts: `
    + `${lastError?.message || lastError?.name || 'unknown error'}`,
  );
}

export function extractPlayerApiConfig(html: string): YouTubePlayerApiConfig | null {
  const apiKey = extractJsonStringSetting(html, 'INNERTUBE_API_KEY');
  const clientVersion = extractJsonStringSetting(html, 'INNERTUBE_CLIENT_VERSION');
  return apiKey && clientVersion ? { apiKey, clientVersion } : null;
}

export function extractInitialData(html: string): JsonObject {
  const markers = ['var ytInitialData =', 'window["ytInitialData"] =', 'ytInitialData ='];

  for (const marker of markers) {
    let markerIndex = html.indexOf(marker);
    while (markerIndex >= 0) {
      const objectStart = html.indexOf('{', markerIndex + marker.length);
      if (objectStart < 0) break;
      const objectEnd = findJsonObjectEnd(html, objectStart);
      if (objectEnd > objectStart) {
        try {
          return JSON.parse(html.slice(objectStart, objectEnd + 1)) as JsonObject;
        } catch {
          // Another marker occurrence may contain the serialized page payload.
        }
      }
      markerIndex = html.indexOf(marker, markerIndex + marker.length);
    }
  }

  throw new Error('YouTube initial page data was not found');
}

export function extractChannelMetadata(initialData: JsonObject) {
  const metadata = initialData?.metadata?.channelMetadataRenderer ?? {};
  const legacyHeader = initialData?.header?.c4TabbedHeaderRenderer ?? {};
  const pageHeader = initialData?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};

  const title: string | null = metadata.title ?? legacyHeader.title ?? null;
  const description: string | null = metadata.description ?? null;
  const handle: string | null = legacyHeader.channelHandleText?.runs?.[0]?.text
    ?? (metadata.vanityChannelUrl ? `@${String(metadata.vanityChannelUrl).split('/@')[1] ?? ''}` : null);

  const avatars = metadata.avatar?.thumbnails ?? legacyHeader.avatar?.thumbnails ?? [];
  const banners = legacyHeader.banner?.thumbnails ?? [];
  let subscriberText: string | null = legacyHeader.subscriberCountText?.simpleText ?? null;
  let videoCountText: string | null = legacyHeader.videosCountText?.runs
    ?.map((run: JsonObject) => run.text)
    .join('') ?? null;

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
  const externalId: string | null = metadata.externalId ?? legacyHeader.channelId ?? null;

  return {
    title,
    description,
    handle,
    avatarUrl: avatars.length ? avatars[avatars.length - 1].url as string : null,
    bannerUrl: banners.length ? banners[banners.length - 1].url as string : null,
    subscriberText,
    videoCountText,
    isVerified: /verified|official artist/i.test(badgeText),
    externalId,
    canonicalUrl: metadata.channelUrl
      ?? (externalId ? `https://www.youtube.com/channel/${externalId}` : null),
  };
}

export function extractChannelAbout(initialData: JsonObject): ChannelAboutMetadata | null {
  let aboutView: JsonObject | null = null;
  walkObjects(initialData, (object) => {
    const candidate = object.aboutChannelViewModel ?? object.channelAboutFullMetadataRenderer;
    if (candidate && typeof candidate === 'object') aboutView = candidate;
  }, () => aboutView !== null);

  if (!aboutView) return null;
  const about = aboutView as JsonObject;
  const links = Array.isArray(about.links) ? about.links : Array.isArray(about.primaryLinks) ? about.primaryLinks : [];
  const externalLinks = deduplicateExternalLinks(links
    .map((item: JsonObject) => {
      const linkView = item?.channelExternalLinkViewModel ?? item;
      const url = normalizeExternalUrl(
        textContent(linkView?.link),
        findFirstHttpUrl(linkView?.link ?? linkView),
      );
      if (!url) return null;
      const rawTitle = textContent(linkView?.title);
      const title = rawTitle && !containsEmailAddress(rawTitle) ? rawTitle.trim() : null;
      return { title: title || null, url, platform: classifyExternalLink(url) };
    })
    .filter((value: ChannelExternalLink | null): value is ChannelExternalLink => value !== null));
  const socialLinks = externalLinks.map(({ url }) => url);
  const websiteLinks = externalLinks
    .filter(({ platform }) => platform === 'website')
    .map(({ url }) => url);
  const socialProfiles = buildSocialProfiles(externalLinks);

  const joinedText = textContent(about.joinedDateText);
  return {
    subscriberText: textContent(about.subscriberCountText),
    videoCountText: textContent(about.videoCountText),
    totalViewsText: textContent(about.viewCountText),
    joinDate: joinedText?.replace(/^joined\s+/i, '') ?? null,
    country: textContent(about.country),
    description: textContent(about.description),
    socialLinks,
    socialProfiles,
    websiteLinks,
    externalLinks,
    canonicalUrl: typeof about.canonicalChannelUrl === 'string' ? about.canonicalChannelUrl : null,
  };
}

export function extractPlayerResponse(html: string): JsonObject {
  const markers = [
    'var ytInitialPlayerResponse =',
    'var ytInitialPlayerResponse=',
    'window["ytInitialPlayerResponse"] =',
    'window["ytInitialPlayerResponse"]=',
    'ytInitialPlayerResponse =',
    'ytInitialPlayerResponse=',
    '"ytInitialPlayerResponse":',
  ];
  let bestResponse: JsonObject | null = null;
  let bestScore = -1;

  for (const marker of markers) {
    let markerIndex = html.indexOf(marker);
    while (markerIndex >= 0) {
      const objectStart = html.indexOf('{', markerIndex + marker.length);
      if (objectStart < 0) break;
      const objectEnd = findJsonObjectEnd(html, objectStart);
      if (objectEnd > objectStart) {
        try {
          const candidate = JSON.parse(html.slice(objectStart, objectEnd + 1)) as JsonObject;
          const score = scorePlayerResponse(candidate);
          if (score > bestScore) {
            bestResponse = candidate;
            bestScore = score;
          }
        } catch {
          // Another marker occurrence may contain the serialized player payload.
        }
      }
      markerIndex = html.indexOf(marker, markerIndex + marker.length);
    }
  }

  if (bestResponse) return bestResponse;
  throw new Error('YouTube player response was not found');
}

export function extractVideoDetails(
  initialData: JsonObject,
  html: string,
  suppliedPlayerResponse?: JsonObject,
): VideoDetailMetadata {
  let playerResponse: JsonObject = suppliedPlayerResponse ?? {};
  if (!suppliedPlayerResponse) {
    try {
      playerResponse = extractPlayerResponse(html);
    } catch {
      // Some video pages still expose useful engagement fields in ytInitialData.
    }
  }

  let primaryInfo: JsonObject | null = null;
  let secondaryInfo: JsonObject | null = null;
  let likeEntity: JsonObject | null = null;
  let commentsHeader: JsonObject | null = null;
  walkObjects(initialData, (object) => {
    if (!primaryInfo && object.videoPrimaryInfoRenderer) primaryInfo = object.videoPrimaryInfoRenderer;
    if (!secondaryInfo && object.videoSecondaryInfoRenderer) secondaryInfo = object.videoSecondaryInfoRenderer;
    if (!likeEntity && object.likeCountEntity) likeEntity = object.likeCountEntity;
    if (!commentsHeader && object.commentsHeaderRenderer) commentsHeader = object.commentsHeaderRenderer;
  });

  const primary = primaryInfo as JsonObject | null;
  const secondary = secondaryInfo as JsonObject | null;
  const likes = likeEntity as JsonObject | null;
  const comments = commentsHeader as JsonObject | null;
  const embeddedVideoDetails = extractBestEmbeddedObject(html, '"videoDetails":', scoreVideoDetails) ?? {};
  const embeddedMicroformat = extractBestEmbeddedObject(
    html,
    '"playerMicroformatRenderer":',
    scoreMicroformat,
  ) ?? {};
  const videoDetails = { ...embeddedVideoDetails, ...(playerResponse.videoDetails ?? {}) };
  const microformat = {
    ...embeddedMicroformat,
    ...(playerResponse.microformat?.playerMicroformatRenderer ?? {}),
  };
  const metaTitle = extractMetaContent(html, 'name', 'title');
  const metaDescription = extractMetaContent(html, 'name', 'description');
  const genericYouTubeTags = new Set(['video', 'sharing', 'camera phone', 'video phone', 'free', 'upload']);
  const metaKeywords = extractMetaContents(html, 'name', 'keywords')
    .map((value) => value.split(',').map((tag) => tag.trim()).filter(Boolean))
    .map((tags) => tags.filter((tag) => !genericYouTubeTags.has(tag.toLowerCase())))
    .filter((tags) => tags.length > 0)
    .sort((left, right) => right.length - left.length)[0] ?? [];
  const metaCategory = extractMetaContent(html, 'itemprop', 'genre')
    ?? extractMetaContent(html, 'name', 'genre');
  const metaPublishedDate = extractMetaContent(html, 'itemprop', 'datePublished')
    ?? extractMetaContent(html, 'itemprop', 'uploadDate')
    ?? extractMetaContent(html, 'property', 'article:published_time');
  const metaDurationSeconds = parseIsoDuration(extractMetaContent(html, 'itemprop', 'duration'));

  const playerViewCount = parseCountValue(videoDetails.viewCount ?? microformat.viewCount);
  const viewCount = textContent(primary?.viewCount?.videoViewCountRenderer?.originalViewCount)
    ?? (playerViewCount === null ? null : `${playerViewCount.toLocaleString('en-US')} views`);
  const likeCountNumber = parseCountValue(
    likes?.likeCountIfIndifferentNumber
      ?? microformat.likeCount
      ?? likes?.likeCountIfLikedNumber,
  );
  const likeCount = textContent(likes?.expandedLikeCountIfIndifferent)
    ?? textContent(likes?.likeCountIfIndifferent)
    ?? (likeCountNumber === null ? null : `${likeCountNumber.toLocaleString('en-US')} likes`);
  const rawCommentCount = textContent(comments?.countText)
    ?? textContent(comments?.commentsCount)
    ?? textContent(comments?.countTextViewModel);
  const commentCountNumber = rawCommentCount && /\d/.test(rawCommentCount)
    ? parseCountValue(rawCommentCount)
    : null;
  const thumbnails = videoDetails.thumbnail?.thumbnails ?? microformat.thumbnail?.thumbnails ?? [];
  const rawDuration = Number.parseInt(String(videoDetails.lengthSeconds ?? microformat.lengthSeconds ?? ''), 10);
  const keywordValues: unknown[] = Array.isArray(videoDetails.keywords) ? videoDetails.keywords : [];
  const tags = keywordValues.length
    ? [...new Set(keywordValues
      .filter((tag: unknown): tag is string => typeof tag === 'string')
      .map((tag: string) => tag.trim())
      .filter(Boolean))].slice(0, 100)
    : [...new Set(metaKeywords)].slice(0, 100);

  return {
    title: typeof videoDetails.title === 'string'
      ? videoDetails.title
      : textContent(microformat.title) ?? metaTitle,
    viewCount,
    likeCount,
    likeCountNumber,
    commentCount: commentCountNumber === null ? null : rawCommentCount,
    commentCountNumber,
    durationSeconds: Number.isSafeInteger(rawDuration) && rawDuration >= 0 ? rawDuration : metaDurationSeconds,
    publishedDate: typeof microformat.publishDate === 'string'
      ? microformat.publishDate
      : typeof microformat.uploadDate === 'string' ? microformat.uploadDate : metaPublishedDate,
    thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1]?.url ?? null : null,
    description: typeof videoDetails.shortDescription === 'string'
      ? videoDetails.shortDescription
      : textContent(secondary?.attributedDescription) ?? textContent(microformat.description) ?? metaDescription,
    tags,
    category: typeof microformat.category === 'string'
      ? microformat.category
      : textContent(microformat.category) ?? metaCategory,
  };
}

export function extractVideos(initialData: JsonObject) {
  const output: Array<{
    videoId: string;
    title: string | null;
    viewText: string | null;
    publishedText: string | null;
    lengthText: string | null;
    thumbnailUrl: string | null;
    navigationUrl: string | null;
    liveStatus: 'live' | 'upcoming' | 'streamed' | null;
  }> = [];
  const seen = new Set<string>();

  const addVideo = (renderer: JsonObject, videoId: string, overrides: Partial<{
    title: string | null;
    viewText: string | null;
    publishedText: string | null;
    lengthText: string | null;
    thumbnailUrl: string | null;
    navigationUrl: string | null;
  }> = {}): void => {
    if (!videoId || seen.has(videoId)) return;
    seen.add(videoId);
    const thumbnails = renderer.thumbnail?.thumbnails
      ?? renderer.thumbnailViewModel?.image?.sources
      ?? renderer.contentImage?.thumbnailViewModel?.image?.sources
      ?? [];
    output.push({
      videoId,
      title: overrides.title ?? textContent(renderer.title) ?? textContent(renderer.headline),
      viewText: overrides.viewText ?? textContent(renderer.viewCountText),
      publishedText: overrides.publishedText ?? textContent(renderer.publishedTimeText),
      lengthText: overrides.lengthText ?? textContent(renderer.lengthText)
        ?? findText(renderer, /^\d{1,2}:\d{2}(?::\d{2})?$/),
      thumbnailUrl: overrides.thumbnailUrl
        ?? (thumbnails.length ? thumbnails[thumbnails.length - 1]?.url ?? null : null),
      navigationUrl: overrides.navigationUrl ?? findNavigationUrl(renderer, videoId),
      liveStatus: detectLiveStatus(renderer),
    });
  };

  walkObjects(initialData, (object) => {
    const videoRenderer = object.videoRenderer;
    if (videoRenderer?.videoId) addVideo(videoRenderer, videoRenderer.videoId);

    const gridVideo = object.gridVideoRenderer;
    if (gridVideo?.videoId) addVideo(gridVideo, gridVideo.videoId);

    const reelItem = object.reelItemRenderer;
    if (reelItem?.videoId) {
      addVideo(reelItem, reelItem.videoId, {
        title: textContent(reelItem.headline),
        navigationUrl: `/shorts/${reelItem.videoId}`,
      });
    }

    const shortsLockup = object.shortsLockupViewModel;
    const shortsVideoId = shortsLockup?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    if (shortsVideoId) {
      const thumbnailSources = shortsLockup.thumbnailViewModel?.thumbnailViewModel?.image?.sources ?? [];
      addVideo(shortsLockup, shortsVideoId, {
        title: textContent(shortsLockup.overlayMetadata?.primaryText),
        viewText: textContent(shortsLockup.overlayMetadata?.secondaryText),
        thumbnailUrl: thumbnailSources.length
          ? thumbnailSources[thumbnailSources.length - 1]?.url ?? null
          : null,
        navigationUrl: `/shorts/${shortsVideoId}`,
      });
    }

    const lockup = object.lockupViewModel;
    if (lockup?.contentId && /VIDEO/i.test(lockup.contentType ?? '') && !seen.has(lockup.contentId)) {
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
      addVideo(lockup, lockup.contentId, {
        title: metadata?.title?.content ?? null,
        viewText,
        publishedText,
        lengthText: findText(lockup.contentImage, /^\d{1,2}:\d{2}(?::\d{2})?$/),
        thumbnailUrl: thumbnailSources.length ? thumbnailSources[thumbnailSources.length - 1].url : null,
        navigationUrl: findNavigationUrl(lockup, lockup.contentId),
      });
    }
  });

  return output;
}

export function extractPlaylists(initialData: JsonObject): PlaylistMetadata[] {
  const output: PlaylistMetadata[] = [];
  const seen = new Set<string>();

  const addPlaylist = (renderer: JsonObject, playlistId: string): void => {
    if (!playlistId || seen.has(playlistId)) return;
    seen.add(playlistId);
    const thumbnails = renderer.thumbnail?.thumbnails
      ?? renderer.thumbnails?.[0]?.thumbnails
      ?? renderer.contentImage?.thumbnailViewModel?.image?.sources
      ?? renderer.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources
      ?? [];
    output.push({
      playlistId,
      title: textContent(renderer.title)
        ?? textContent(renderer.metadata?.lockupMetadataViewModel?.title),
      videoCountText: textContent(renderer.videoCountText)
        ?? findText(renderer, /^\s*[\d,.]+\s+(?:videos?|episodes?)\s*$/i),
      thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1]?.url ?? null : null,
    });
  };

  walkObjects(initialData, (object) => {
    for (const key of ['playlistRenderer', 'gridPlaylistRenderer']) {
      const renderer = object[key];
      if (renderer?.playlistId) addPlaylist(renderer, renderer.playlistId);
    }
    const lockup = object.lockupViewModel;
    if (lockup?.contentId && /PLAYLIST/i.test(lockup.contentType ?? '')) {
      addPlaylist(lockup, lockup.contentId);
    }
  });

  return output;
}

export function extractCommunityPosts(initialData: JsonObject): CommunityPostMetadata[] {
  const output: CommunityPostMetadata[] = [];
  const seen = new Set<string>();

  walkObjects(initialData, (object) => {
    const post = object.backstagePostRenderer ?? object.postRenderer;
    const postId = post?.postId ?? post?.id;
    if (typeof postId !== 'string' || !postId || seen.has(postId)) return;
    seen.add(postId);

    let attachmentType: CommunityPostMetadata['attachmentType'] = 'none';
    let attachmentUrl: string | null = null;
    let imageUrl: string | null = null;
    walkObjects(post, (child) => {
      if (attachmentType === 'none' && (child.pollRenderer || child.backstagePollRenderer)) {
        attachmentType = 'poll';
      }
      const video = child.videoRenderer ?? child.gridVideoRenderer ?? child.reelItemRenderer;
      if (video?.videoId && attachmentType !== 'video') {
        attachmentType = 'video';
        attachmentUrl = video.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url
          ? new URL(video.navigationEndpoint.commandMetadata.webCommandMetadata.url, 'https://www.youtube.com').toString()
          : `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
      }
      const playlist = child.playlistRenderer ?? child.gridPlaylistRenderer;
      if (playlist?.playlistId && attachmentType === 'none') {
        attachmentType = 'playlist';
        attachmentUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.playlistId)}`;
      }
      const imageRenderer = child.backstageImageRenderer ?? child.imageRenderer;
      const thumbnails = imageRenderer?.image?.thumbnails ?? imageRenderer?.thumbnails ?? [];
      if (!imageUrl && thumbnails.length) {
        imageUrl = thumbnails[thumbnails.length - 1]?.url ?? null;
        if (attachmentType === 'none') attachmentType = 'image';
      }
    });

    output.push({
      postId,
      text: textContent(post.contentText) ?? textContent(post.content),
      publishedText: textContent(post.publishedTimeText) ?? textContent(post.publishedTime),
      likeCountText: textContent(post.voteCount) ?? textContent(post.likeCount),
      commentCountText: textContent(post.replyCount) ?? textContent(post.commentCount),
      attachmentType,
      attachmentUrl,
      imageUrl,
    });
  });

  return output;
}

export function extractSearchChannelUrls(initialData: JsonObject, maximum: number): string[] {
  const urls = new Set<string>();

  const addUrl = (rawUrl: unknown): void => {
    if (urls.size >= maximum || typeof rawUrl !== 'string') return;
    if (!/^\/(?:@|channel\/|c\/|user\/)/i.test(rawUrl)) return;
    urls.add(`https://www.youtube.com${rawUrl.split(/[?#]/)[0]}`);
  };

  walkObjects(initialData, (object) => {
    const channel = object.channelRenderer;
    if (channel) {
      addUrl(channel.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url);
      if (channel.channelId) addUrl(`/channel/${channel.channelId}`);
    }
  }, () => urls.size >= maximum);

  return [...urls].slice(0, maximum);
}

function walkObjects(
  value: unknown,
  visitor: (object: JsonObject) => void,
  stop = () => false,
): void {
  if (stop() || !value || typeof value !== 'object') return;
  visitor(value as JsonObject);
  if (stop()) return;
  for (const child of Object.values(value as JsonObject)) {
    walkObjects(child, visitor, stop);
    if (stop()) return;
  }
}

function findText(value: unknown, pattern: RegExp): string | null {
  let result: string | null = null;
  walkObjects(value, (object) => {
    if (result) return;
    if (typeof object.text === 'string' && pattern.test(object.text)) result = object.text;
    else if (typeof object.content === 'string' && pattern.test(object.content)) result = object.content;
  }, () => result !== null);
  return result;
}

function findNavigationUrl(value: unknown, videoId: string): string | null {
  let shortsUrl: string | null = null;
  let watchUrl: string | null = null;
  walkObjects(value, (object) => {
    for (const [key, child] of Object.entries(object)) {
      if (typeof child !== 'string' || !/url/i.test(key)) continue;
      if (child.includes(`/shorts/${videoId}`)) shortsUrl = child;
      else if (!watchUrl && child.includes(`/watch?v=${videoId}`)) watchUrl = child;
    }
  }, () => shortsUrl !== null);
  return shortsUrl ?? watchUrl;
}

function detectLiveStatus(value: unknown): 'live' | 'upcoming' | 'streamed' | null {
  let status: 'live' | 'upcoming' | 'streamed' | null = null;
  walkObjects(value, (object) => {
    if (status) return;
    if (object.isLiveNow === true || /LIVE_NOW/i.test(String(object.style ?? ''))) {
      status = 'live';
      return;
    }
    if (object.upcomingEventData || /UPCOMING/i.test(String(object.style ?? ''))) {
      status = 'upcoming';
      return;
    }
    for (const child of Object.values(object)) {
      if (typeof child !== 'string') continue;
      if (/^(?:LIVE|LIVE NOW)$/i.test(child.trim())) status = 'live';
      else if (/^UPCOMING$/i.test(child.trim())) status = 'upcoming';
      else if (/^STREAMED\b/i.test(child.trim())) status = 'streamed';
      if (status) return;
    }
  }, () => status !== null);
  return status;
}

function textContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    const combined = value.map(textContent).filter(Boolean).join('');
    return combined || null;
  }

  const object = value as JsonObject;
  for (const key of ['content', 'simpleText', 'text']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  if (Array.isArray(object.runs)) {
    const combined = object.runs.map((run: JsonObject) => textContent(run)).filter(Boolean).join('');
    if (combined) return combined;
  }
  return null;
}

function parseCountValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const text = textContent(value);
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  let number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number) || number < 0) return null;
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'B') number *= 1_000_000_000;
  else if (suffix === 'M') number *= 1_000_000;
  else if (suffix === 'K') number *= 1_000;
  return Math.round(number);
}

function scorePlayerResponse(candidate: JsonObject): number {
  let score = 0;
  if (candidate.videoDetails) score += 4;
  if (candidate.microformat?.playerMicroformatRenderer) score += 4;
  if (Array.isArray(candidate.videoDetails?.keywords)) score += 2;
  if (candidate.videoDetails?.shortDescription) score += 1;
  return score;
}

function scoreVideoDetails(candidate: JsonObject): number {
  let score = 0;
  if (candidate.videoId) score += 2;
  if (candidate.title) score += 1;
  if (candidate.lengthSeconds) score += 1;
  if (candidate.shortDescription) score += 2;
  if (Array.isArray(candidate.keywords)) score += 2;
  return score;
}

function scoreMicroformat(candidate: JsonObject): number {
  let score = 0;
  if (candidate.publishDate || candidate.uploadDate) score += 2;
  if (candidate.category) score += 2;
  if (candidate.description) score += 1;
  if (candidate.lengthSeconds) score += 1;
  return score;
}

function extractBestEmbeddedObject(
  html: string,
  marker: string,
  score: (candidate: JsonObject) => number,
): JsonObject | null {
  let best: JsonObject | null = null;
  let bestScore = -1;
  let markerIndex = html.indexOf(marker);
  while (markerIndex >= 0) {
    const objectStart = html.indexOf('{', markerIndex + marker.length);
    if (objectStart < 0) break;
    const objectEnd = findJsonObjectEnd(html, objectStart);
    if (objectEnd > objectStart) {
      try {
        const candidate = JSON.parse(html.slice(objectStart, objectEnd + 1)) as JsonObject;
        const candidateScore = score(candidate);
        if (candidateScore > bestScore) {
          best = candidate;
          bestScore = candidateScore;
        }
      } catch {
        // The same marker can occur inside an escaped string; keep scanning.
      }
    }
    markerIndex = html.indexOf(marker, markerIndex + marker.length);
  }
  return best;
}

function extractMetaContent(html: string, attributeName: string, attributeValue: string): string | null {
  return extractMetaContents(html, attributeName, attributeValue).at(-1) ?? null;
}

function extractMetaContents(html: string, attributeName: string, attributeValue: string): string[] {
  const output: string[] = [];
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const identity = readHtmlAttribute(tag, attributeName);
    if (identity?.toLowerCase() !== attributeValue.toLowerCase()) continue;
    const content = readHtmlAttribute(tag, 'content');
    if (content) output.push(decodeHtmlEntities(content));
  }
  return output;
}

function readHtmlAttribute(tag: string, attributeName: string): string | null {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseIsoDuration(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  return Number.parseInt(match[1] ?? '0', 10) * 3600
    + Number.parseInt(match[2] ?? '0', 10) * 60
    + Number.parseInt(match[3] ?? '0', 10);
}

function extractJsonStringSetting(html: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function findFirstHttpUrl(value: unknown): string | null {
  let result: string | null = null;
  walkObjects(value, (object) => {
    for (const child of Object.values(object)) {
      if (typeof child === 'string' && /^(?:https?:\/\/|\/redirect\?)/i.test(child)) {
        result = child;
        return;
      }
    }
  }, () => result !== null);
  return result;
}

function normalizeExternalUrl(displayValue: string | null, endpointValue: string | null): string | null {
  for (const rawValue of [displayValue, endpointValue]) {
    if (!rawValue) continue;
    let candidate = rawValue.trim();
    if (containsEmailAddress(candidate) || /^mailto:/i.test(candidate)) continue;
    try {
      const redirectUrl = new URL(candidate, 'https://www.youtube.com');
      if (/^(?:www\.)?youtube\.com$/i.test(redirectUrl.hostname) && redirectUrl.pathname === '/redirect') {
        candidate = redirectUrl.searchParams.get('q') ?? redirectUrl.searchParams.get('u') ?? '';
      }
      if (!candidate) continue;
      if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate.replace(/^\/+/, '')}`;
      const parsed = new URL(candidate);
      if (
        !['http:', 'https:'].includes(parsed.protocol)
        || parsed.username
        || parsed.password
        || !parsed.hostname.includes('.')
        || containsEmailAddress(decodeURIComponent(parsed.toString()))
      ) continue;
      parsed.hash = '';
      return parsed.toString();
    } catch {
      // Try the next available representation of the public link.
    }
  }
  return null;
}

export function classifyExternalLink(url: string): ExternalLinkPlatform {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  if (hostname === 'facebook.com' || hostname.endsWith('.facebook.com')) return 'facebook';
  if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) return 'instagram';
  if (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com')) return 'linkedin';
  if (hostname === 'x.com' || hostname.endsWith('.x.com')
    || hostname === 'twitter.com' || hostname.endsWith('.twitter.com')) return 'x';
  if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be') return 'youtube';
  if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) return 'tiktok';
  if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com')) return 'reddit';
  if (hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv')) return 'twitch';
  if (hostname === 'threads.net' || hostname.endsWith('.threads.net')) return 'threads';
  if (hostname === 'discord.com' || hostname.endsWith('.discord.com') || hostname === 'discord.gg') return 'discord';
  return 'website';
}

function deduplicateExternalLinks(links: ChannelExternalLink[]): ChannelExternalLink[] {
  const unique = new Map<string, ChannelExternalLink>();
  for (const link of links) {
    const key = link.url.toLowerCase();
    const existing = unique.get(key);
    if (!existing || (!existing.title && link.title)) unique.set(key, link);
  }
  return [...unique.values()];
}

function buildSocialProfiles(links: ChannelExternalLink[]): SocialProfiles {
  const profiles: SocialProfiles = {
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
  for (const link of links) {
    if (link.platform !== 'website') profiles[link.platform].push(link.url);
  }
  return profiles;
}

function containsEmailAddress(value: string): boolean {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value);
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function readHtmlTitle(html: string): string {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
}

function stripMarkup(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}
