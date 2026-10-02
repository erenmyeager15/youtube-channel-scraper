/** Parse only public content in a requested channel tab, never document-wide recommendations. */
import { isPlaylistLockup } from './playlist-identity.js';
export type ContentSection = 'videos' | 'shorts' | 'streams' | 'playlists' | 'community';
export type ContentItem = Record<string, any>;

export interface ContentPage {
  recognized: boolean;
  items: ContentItem[];
  continuationToken: string | null;
  /** Opaque feed identity from the verified container carrying this token. Never guessed. */
  continuationTargetId: string | null;
  emptyConfirmed: boolean;
  continuationAmbiguous: boolean;
}

export const MAX_CONTENT_PAGE_ITEMS = 5_000;
const MAX_PARSE_NODES = 20_000;
const MAX_PARSE_DEPTH = 20;
const MAX_TOKEN_LENGTH = 16_384;

interface ParseState {
  section: ContentSection;
  ownerId: string | null;
  items: ContentItem[];
  tokens: Set<string>;
  tokenTargets: Map<string, Set<string | null>>;
  supported: boolean;
  ambiguous: boolean;
  containerFound: boolean;
  nodes: number;
}

interface Region {
  items: unknown[];
  targetId: string | null;
  source: 'action' | 'container';
  continuations?: unknown;
}

const CARD_KEYS = new Set([
  'videoRenderer', 'gridVideoRenderer', 'reelItemRenderer', 'shortsLockupViewModel',
  'lockupViewModel', 'playlistRenderer', 'gridPlaylistRenderer', 'backstagePostRenderer', 'postRenderer',
]);
const SKIP_NESTED_KEYS = new Set([
  ...CARD_KEYS, 'backstagePostThreadRenderer', 'postThreadRenderer', 'richItemRenderer',
  'richSectionRenderer', 'richShelfRenderer', 'shelfRenderer', 'horizontalListRenderer',
  'engagementPanelSectionListRenderer', 'commentsEntryPointHeaderRenderer',
  'continuationItemRenderer', 'recommendations', 'relatedVideos', 'suggestedVideos',
  // Playback/menu actions are not public card metadata. Modern lockups nest these
  // past 20 levels; copying them falsely made a valid feed hit the depth guard.
  'menuButton', 'menuRenderer', 'thumbnailHoverOverlayToggleActionsViewModel',
  'signalServiceEndpoint', 'showSheetCommand', 'watchEndpointSupportedOnesieConfig',
  'trackingParams', 'clickTrackingParams', 'loggingDirectives',
]);

export function extractContentPage(
  initialData: ContentItem,
  section: ContentSection,
  continuation = false,
  expectedChannelId?: string | null,
  expectedTargetId?: string | null,
): ContentPage {
  const state: ParseState = {
    section,
    ownerId: expectedChannelId
      ?? initialData?.metadata?.channelMetadataRenderer?.externalId
      ?? initialData?.header?.c4TabbedHeaderRenderer?.channelId
      ?? null,
    items: [],
    tokens: new Set(),
    tokenTargets: new Map(),
    supported: true,
    ambiguous: false,
    containerFound: false,
    nodes: 0,
  };

  // An explicit source identity must not disagree with the channel already verified by the caller.
  const sourceOwnerId = initialData?.metadata?.channelMetadataRenderer?.externalId
    ?? initialData?.header?.c4TabbedHeaderRenderer?.channelId;
  if (expectedChannelId && typeof sourceOwnerId === 'string' && sourceOwnerId !== expectedChannelId) {
    return result(state, false);
  }

  if (continuation) {
    const regions = continuationRegions(initialData, state.ownerId, section, expectedTargetId ?? null);
    if (regions.length === 0) return result(state, false);
    const first = regions[0];
    if (regions.length > 1 && (first.source !== 'action' || !first.targetId
      || regions.some((region) => region.source !== 'action' || region.targetId !== first.targetId))) {
      state.ambiguous = true;
      return result(state, false);
    }
    state.containerFound = true;
    for (const region of regions) {
      readContinuations(region.continuations, state, region.targetId ?? expectedTargetId ?? null);
      readEntries(region.items, state, 0, region.targetId ?? expectedTargetId ?? null);
    }
  } else {
    const tabs = initialData?.contents?.twoColumnBrowseResultsRenderer?.tabs
      ?? initialData?.contents?.singleColumnBrowseResultsRenderer?.tabs;
    if (!Array.isArray(tabs)) return result(state, false);
    const matches = tabs
      .map((entry) => entry?.tabRenderer ?? entry?.expandableTabRenderer)
      .filter((tab) => tab?.selected === true && tabSection(tab, state.ownerId) === section);
    if (matches.length !== 1) {
      state.ambiguous = matches.length > 1;
      return result(state, false);
    }
    readEntry(matches[0].content, state, 0);
  }

  return result(state, state.containerFound && state.supported);
}

function result(state: ParseState, recognized: boolean): ContentPage {
  const continuationAmbiguous = state.ambiguous || state.tokens.size > 1
    || [...state.tokenTargets.values()].some((targets) => targets.size > 1);
  const token = continuationAmbiguous ? null : [...state.tokens][0] ?? null;
  return {
    recognized,
    items: state.items,
    continuationToken: token,
    continuationTargetId: token ? [...(state.tokenTargets.get(token) ?? [])][0] ?? null : null,
    emptyConfirmed: recognized && !continuationAmbiguous && state.items.length === 0 && state.tokens.size === 0,
    continuationAmbiguous,
  };
}

function tabSection(tab: ContentItem, ownerId: string | null): ContentSection | null {
  const rawUrl = tab.endpoint?.commandMetadata?.webCommandMetadata?.url
    ?? tab.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
  if (typeof rawUrl !== 'string') return null;
  try {
    const url = new URL(rawUrl, 'https://www.youtube.com');
    if (url.origin !== 'https://www.youtube.com') return null;
    const match = url.pathname.match(/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(videos|shorts|streams|playlists|posts|community)\/?$/);
    const explicitOwner = url.pathname.match(/^\/channel\/([^/]+)\//)?.[1];
    if (ownerId && explicitOwner && explicitOwner !== ownerId) return null;
    return match ? (match[1] === 'posts' ? 'community' : match[1]) as ContentSection : null;
  } catch {
    return null;
  }
}

function continuationRegions(data: ContentItem, ownerId: string | null, section: ContentSection, expectedTargetId: string | null): Region[] {
  const regions: Region[] = [];
  for (const key of ['onResponseReceivedActions', 'onResponseReceivedEndpoints']) {
    if (!Array.isArray(data?.[key])) continue;
    for (const entry of data[key]) {
      for (const actionKey of ['appendContinuationItemsAction', 'reloadContinuationItemsCommand']) {
        const action = entry?.[actionKey];
        if (!Array.isArray(action?.continuationItems)) continue;
        const targetId = typeof action.targetId === 'string' ? action.targetId : null;
        if (targetId && !isChannelContentTarget(targetId, ownerId, section, expectedTargetId)) continue;
        if (expectedTargetId && !targetId) continue;
        regions.push({ items: action.continuationItems, targetId, source: 'action' });
      }
    }
  }
  for (const [key, itemKey] of [
    ['richGridContinuation', 'contents'], ['gridContinuation', 'items'],
    ['itemSectionContinuation', 'contents'], ['sectionListContinuation', 'contents'],
  ]) {
    const container = data?.continuationContents?.[key];
    if (!Array.isArray(container?.[itemKey])) continue;
    regions.push({
      items: container[itemKey], targetId: null, source: 'container', continuations: container.continuations,
    });
  }
  return regions;
}

function isSafeScopedTarget(target: string, ownerId: string | null, section: ContentSection): boolean {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(target)) return false;
  if (/comment|engagement|related|recommend|notification|watch.next|guide|chat|survey|masthead/i.test(target)) return false;
  if (ownerId && target.startsWith('browse-feedUC')) {
    const base = `browse-feed${ownerId}`;
    if (!target.startsWith(base)) return false;
    const suffix = target.slice(base.length);
    const sections = section === 'community' ? ['posts', 'community'] : [section];
    if (suffix && !sections.some((name) => suffix.startsWith(name) && /^\d*$/.test(suffix.slice(name.length)))) return false;
  }
  return true;
}

function isChannelContentTarget(target: string, ownerId: string | null, section: ContentSection, expectedTargetId: string | null): boolean {
  if (!isSafeScopedTarget(target, ownerId, section)) return false;
  if (expectedTargetId) return target === expectedTargetId;
  return /^(?:browse-feed(?:UC[A-Za-z0-9_-]+)?|rich-grid|grid|section-list|item-section|channel-posts|community-feed)$/.test(target);
}

function readEntries(entries: unknown[], state: ParseState, depth: number, targetId: string | null = null): void {
  for (const entry of entries) {
    if (!withinBounds(state, depth)) return;
    readEntry(entry, state, depth + 1, targetId);
  }
}

function withinBounds(state: ParseState, depth: number): boolean {
  state.nodes += 1;
  if (state.nodes > MAX_PARSE_NODES || depth > MAX_PARSE_DEPTH || state.items.length >= MAX_CONTENT_PAGE_ITEMS) {
    state.supported = false;
    state.ambiguous = true;
    return false;
  }
  return true;
}

function readEntry(entry: unknown, state: ParseState, depth: number, targetId: string | null = null): void {
  if (!withinBounds(state, depth) || !isObject(entry)) {
    state.supported = false;
    return;
  }
  if (entry.continuationItemRenderer) {
    const renderer = entry.continuationItemRenderer;
    const token = renderer.continuationEndpoint?.continuationCommand?.token
      ?? renderer.button?.buttonRenderer?.command?.continuationCommand?.token;
    addToken(token, state, targetId);
    return;
  }

  // Terminal rows stop structural traversal. Copies contain only fields used by public card parsers.
  const cards = Object.keys(entry).filter((key) => CARD_KEYS.has(key));
  if (cards.length > 0) {
    if (cards.length !== 1 || !readCard(cards[0], entry[cards[0]], state)) state.supported = false;
    return;
  }

  for (const [key, itemKey] of [
    ['richGridRenderer', 'contents'], ['gridRenderer', 'items'],
    ['sectionListRenderer', 'contents'], ['itemSectionRenderer', 'contents'],
  ]) {
    if (!entry[key]) continue;
    const container = entry[key];
    if (!Array.isArray(container[itemKey])) {
      state.supported = false;
      return;
    }
    state.containerFound = true;
    const scopedTarget = container.targetId ?? targetId;
    if (scopedTarget !== null && (typeof scopedTarget !== 'string'
      || !isSafeScopedTarget(scopedTarget, state.ownerId, state.section))) {
      state.supported = false;
      state.ambiguous = true;
    }
    const safeTarget = typeof scopedTarget === 'string' ? scopedTarget : null;
    readContinuations(container.continuations, state, safeTarget);
    readEntries(container[itemKey], state, depth + 1, safeTarget);
    return;
  }

  if (entry.richItemRenderer?.content) {
    readEntry(entry.richItemRenderer.content, state, depth + 1, targetId);
    return;
  }
  if (state.section === 'community') {
    const thread = entry.backstagePostThreadRenderer ?? entry.postThreadRenderer;
    if (thread?.post) {
      readEntry(thread.post, state, depth + 1, targetId);
      return;
    }
  }
  if (entry.messageRenderer && isConfirmedEmptyMessage(entry.messageRenderer)) {
    state.containerFound = true;
    return;
  }
  // Shelves and unknown wrappers may hide different feeds. They cannot establish exhaustion.
  state.supported = false;
}

function readCard(key: string, card: unknown, state: ParseState): boolean {
  if (!isObject(card)) return false;
  let fields: string[];
  if (state.section === 'community') {
    if (!['backstagePostRenderer', 'postRenderer'].includes(key)) return false;
    if (typeof (card.postId ?? card.id) !== 'string') return false;
    const authorId = card.authorEndpoint?.browseEndpoint?.browseId;
    if (state.ownerId && typeof authorId === 'string' && authorId !== state.ownerId) return false;
    fields = ['postId', 'id', 'contentText', 'content', 'publishedTimeText', 'publishedTime',
      'voteCount', 'likeCount', 'replyCount', 'commentCount', 'authorEndpoint'];
  } else if (state.section === 'playlists') {
    if (!['playlistRenderer', 'gridPlaylistRenderer', 'lockupViewModel'].includes(key)) return false;
    if (key === 'lockupViewModel' && !isPlaylistLockup(card)) return false;
    if (typeof (card.playlistId ?? card.contentId) !== 'string') return false;
    fields = ['playlistId', 'contentId', 'contentType', 'title', 'videoCountText', 'thumbnail',
      'thumbnails', 'contentImage', 'metadata', 'navigationEndpoint', 'rendererContext'];
  } else {
    if (!['videoRenderer', 'gridVideoRenderer', 'reelItemRenderer', 'shortsLockupViewModel', 'lockupViewModel'].includes(key)) return false;
    if (key === 'lockupViewModel' && !/VIDEO/i.test(String(card.contentType ?? ''))) return false;
    const videoId = card.videoId ?? card.contentId ?? card.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    if (typeof videoId !== 'string' || !videoId) return false;
    fields = ['videoId', 'contentId', 'contentType', 'title', 'headline', 'viewCountText',
      'publishedTimeText', 'lengthText', 'thumbnail', 'thumbnailViewModel', 'contentImage',
      'navigationEndpoint', 'badges', 'thumbnailOverlays', 'upcomingEventData', 'isLiveNow',
      'onTap', 'overlayMetadata', 'metadata'];
  }
  const sanitized: ContentItem = {};
  for (const field of fields) {
    if (card[field] !== undefined) sanitized[field] = copyPublicField(card[field], state, 0);
  }
  if (state.section === 'community' && card.backstageAttachment) {
    sanitized.backstageAttachment = sanitizeAttachment(card.backstageAttachment, state);
  }
  state.items.push({ [key]: sanitized });
  return true;
}

function sanitizeAttachment(value: unknown, state: ParseState): ContentItem {
  if (!isObject(value)) return {};
  const attachment = sanitizeImageAttachment(value, state);
  for (const key of ['pollRenderer', 'backstagePollRenderer']) {
    if (isObject(value[key])) attachment[key] = copyPublicField(value[key], state, 0);
  }
  const carousel = value.postMultiImageRenderer;
  if (isObject(carousel) && Array.isArray(carousel.images)) {
    const images: ContentItem[] = [];
    for (const image of carousel.images) {
      if (!withinBounds(state, 0)) break;
      if (!isObject(image)) continue;
      const copied = sanitizeImageAttachment(image, state);
      if (Object.keys(copied).length > 0) images.push(copied);
    }
    attachment.postMultiImageRenderer = { images };
  }
  for (const key of ['videoRenderer', 'gridVideoRenderer', 'reelItemRenderer', 'playlistRenderer', 'gridPlaylistRenderer']) {
    const renderer = value[key];
    if (!isObject(renderer)) continue;
    const copied: ContentItem = {};
    for (const field of ['videoId', 'playlistId', 'title', 'navigationEndpoint', 'thumbnail', 'thumbnails']) {
      if (renderer[field] !== undefined) copied[field] = copyPublicField(renderer[field], state, 0);
    }
    attachment[key] = copied;
  }
  return attachment;
}

function sanitizeImageAttachment(value: ContentItem, state: ParseState): ContentItem {
  const attachment: ContentItem = {};
  for (const key of ['backstageImageRenderer', 'imageRenderer']) {
    const renderer = value[key];
    if (!isObject(renderer)) continue;
    const copied: ContentItem = {};
    if (renderer.image?.thumbnails !== undefined) {
      copied.image = { thumbnails: copyPublicField(renderer.image.thumbnails, state, 0) };
    }
    if (renderer.thumbnails !== undefined) copied.thumbnails = copyPublicField(renderer.thumbnails, state, 0);
    attachment[key] = copied;
  }
  return attachment;
}

function copyPublicField(value: unknown, state: ParseState, depth: number): unknown {
  if (!withinBounds(state, depth)) return null;
  if (Array.isArray(value)) return value.map((child) => copyPublicField(child, state, depth + 1));
  if (!isObject(value)) return value;
  const copy: ContentItem = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SKIP_NESTED_KEYS.has(key)) copy[key] = copyPublicField(child, state, depth + 1);
  }
  return copy;
}

function readContinuations(value: unknown, state: ParseState, targetId: string | null = null): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    state.supported = false;
    return;
  }
  for (const entry of value) {
    if (entry?.nextContinuationData) addToken(entry.nextContinuationData.continuation, state, targetId);
    else state.supported = false;
  }
}

function addToken(token: unknown, state: ParseState, targetId: string | null = null): void {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH || /[\u0000-\u001f]/.test(token)) {
    state.supported = false;
    state.ambiguous = true;
    return;
  }
  state.tokens.add(token);
  const targets = state.tokenTargets.get(token) ?? new Set<string | null>();
  targets.add(targetId);
  state.tokenTargets.set(token, targets);
}

function isObject(value: unknown): value is ContentItem {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isConfirmedEmptyMessage(renderer: ContentItem): boolean {
  const text = renderer.text?.simpleText ?? renderer.text?.runs?.map((run: ContentItem) => run.text ?? '').join('');
  return typeof text === 'string' && /^(?:this channel has no (?:videos|playlists|shorts|streams)|this channel hasn't posted yet|no (?:videos|playlists|shorts|posts)(?: yet)?)\.?$/i.test(text.trim());
}
