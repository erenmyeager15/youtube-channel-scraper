import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractContentPage, type ContentSection } from './content-pagination.js';
import { extractCommunityPosts, extractPlaylists, extractVideos } from './youtube-http.js';

const video = (id: string, extra = {}) => ({ videoRenderer: { videoId: id, title: { simpleText: id }, ...extra } });
const token = (value: string) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: value } } } });
const tabPage = (section: ContentSection, content: any, extra = {}) => ({
  metadata: { channelMetadataRenderer: { externalId: 'UC_OWNER' } },
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
    selected: true,
    endpoint: { commandMetadata: { webCommandMetadata: { url: `/channel/UC_OWNER/${section === 'community' ? 'posts' : section}` } } },
    content,
  } }] } },
  ...extra,
});
const richPage = (section: ContentSection, entries: any[]) => tabPage(section, { richGridRenderer: { contents: entries } });
const continuationPage = (entries: any[], targetId = 'browse-feed') => ({
  onResponseReceivedActions: [{ appendContinuationItemsAction: { targetId, continuationItems: entries } }],
});

test('initial content stays inside the selected requested channel tab', () => {
  const fixture = richPage('videos', [{ richItemRenderer: { content: video('owned') } }, token('NEXT')]);
  const data = { ...fixture, header: video('header-recommendation'), engagementPanels: [video('panel-video')] };
  data.contents.twoColumnBrowseResultsRenderer.tabs.push({ tabRenderer: {
    selected: false,
    endpoint: { commandMetadata: { webCommandMetadata: { url: '/channel/UC_OWNER/shorts' } } },
    content: { richGridRenderer: { contents: [video('other-tab')] } },
  } });
  const page = extractContentPage(data, 'videos');
  assert.equal(page.recognized, true);
  assert.deepEqual(extractVideos({ contents: page.items }).map((item) => item.videoId), ['owned']);
  assert.equal(page.continuationToken, 'NEXT');
  assert.equal(page.emptyConfirmed, false);
  assert.equal(extractContentPage(data, 'shorts').recognized, false);
});

test('flat arbitrary renderer fixtures and malformed or foreign selected tabs are unrecognized', () => {
  assert.equal(extractContentPage({ contents: [video('arbitrary')] }, 'videos').recognized, false);
  const fixture = richPage('videos', []);
  fixture.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.selected = false;
  assert.equal(extractContentPage(fixture, 'videos').emptyConfirmed, false);
  fixture.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.selected = true;
  fixture.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.endpoint.commandMetadata.webCommandMetadata.url = 'https://evil.example/@owner/videos';
  assert.equal(extractContentPage(fixture, 'videos').recognized, false);
});

test('explicit foreign channel identities never become owned content or verified empty feeds', () => {
  const foreignTab = richPage('videos', [video('foreign-video')]);
  foreignTab.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.endpoint.commandMetadata.webCommandMetadata.url = '/channel/UC_OTHER/videos';
  const parsedTab = extractContentPage(foreignTab, 'videos', false, 'UC_OWNER');
  assert.equal(parsedTab.recognized, false);
  assert.equal(parsedTab.emptyConfirmed, false);
  assert.deepEqual(parsedTab.items, []);
  const foreignEmptyTab = richPage('videos', []);
  foreignEmptyTab.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.endpoint.commandMetadata.webCommandMetadata.url = '/channel/UC_OTHER/videos';
  assert.equal(extractContentPage(foreignEmptyTab, 'videos', false, 'UC_OWNER').emptyConfirmed, false);

  const foreignContinuation = extractContentPage(continuationPage([video('foreign-video')], 'browse-feedUC_OTHER'), 'videos', true, 'UC_OWNER');
  assert.equal(foreignContinuation.recognized, false);
  assert.equal(foreignContinuation.emptyConfirmed, false);
  assert.deepEqual(foreignContinuation.items, []);
  assert.equal(extractContentPage(continuationPage([], 'browse-feedUC_OTHER'), 'videos', true, 'UC_OWNER').emptyConfirmed, false);

  const contradictoryMetadata = richPage('videos', [video('foreign-video')]);
  contradictoryMetadata.metadata.channelMetadataRenderer.externalId = 'UC_OTHER';
  assert.equal(extractContentPage(contradictoryMetadata, 'videos', false, 'UC_OWNER').recognized, false);
});

test('matching explicit identities and unqualified channel feeds remain supported', () => {
  const owned = extractContentPage(richPage('videos', [video('owned')]), 'videos', false, 'UC_OWNER');
  assert.equal(owned.recognized, true);
  for (const target of ['browse-feedUC_OWNER', 'browse-feed', 'rich-grid']) {
    const parsed = extractContentPage(continuationPage([video('owned')], target), 'videos', true, 'UC_OWNER');
    assert.equal(parsed.recognized, true);
    assert.equal(parsed.items.length, 1);
  }
  const handleTab = richPage('videos', [video('owned')]);
  handleTab.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.endpoint.commandMetadata.webCommandMetadata.url = '/@owner/videos';
  assert.equal(extractContentPage(handleTab, 'videos', false, 'UC_OWNER').recognized, true);
});

test('recognized empty containers establish an empty first page; unsupported payloads do not', () => {
  const empty = extractContentPage(richPage('videos', []), 'videos');
  assert.equal(empty.emptyConfirmed, true);
  assert.equal(extractContentPage(tabPage('videos', { richGridRenderer: {} }), 'videos').emptyConfirmed, false);
  const unsupported = extractContentPage(richPage('videos', [{ unknownVideoWrapper: video('hidden') }]), 'videos');
  assert.equal(unsupported.recognized, false);
  assert.equal(unsupported.emptyConfirmed, false);
});

test('nested grid and item sections contain only direct cards and a scoped continuation', () => {
  const data = tabPage('playlists', { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ gridRenderer: {
    items: [{ gridPlaylistRenderer: { playlistId: 'PL_OWNED', title: { simpleText: 'Owned playlist' }, recommendations: video('suggested') } }],
    continuations: [{ nextContinuationData: { continuation: 'GRID_NEXT' } }],
  } }] } }] } });
  const page = extractContentPage(data, 'playlists');
  assert.equal(page.recognized, true);
  assert.equal(page.continuationToken, 'GRID_NEXT');
  assert.deepEqual(extractPlaylists({ contents: page.items }).map((item) => item.playlistId), ['PL_OWNED']);
  assert.deepEqual(extractVideos({ contents: page.items }), []);
});

test('terminal cards omit nested recommendation renderers and their continuation tokens', () => {
  const data = richPage('videos', [video('owned', {
    title: { simpleText: 'Owned', unrelated: video('nested') },
    recommendations: [video('recommended'), token('WRONG_NEXT')],
  })]);
  const page = extractContentPage(data, 'videos');
  assert.equal(page.recognized, true);
  assert.equal(page.continuationToken, null);
  assert.deepEqual(extractVideos({ contents: page.items }).map((item) => item.videoId), ['owned']);
});

test('community thread extraction retains public attachments but omits replies and foreign posts', () => {
  const post = (id: string, author = 'UC_OWNER') => ({ backstagePostThreadRenderer: {
    post: { backstagePostRenderer: {
      postId: id,
      authorEndpoint: { browseEndpoint: { browseId: author } },
      contentText: { runs: [{ text: 'Public update' }] },
      backstageAttachment: { videoRenderer: { videoId: 'attachment', recommendations: video('nested-recommendation') } },
      recommendations: { backstagePostRenderer: { postId: 'suggested-post' } },
    } },
    replies: [{ backstagePostRenderer: { postId: 'reply', contentText: { simpleText: 'Comment' } } }],
  } });
  const page = extractContentPage(tabPage('community', { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [post('owned')] } }] } }), 'community');
  assert.equal(page.recognized, true);
  const parsed = extractCommunityPosts({ contents: page.items });
  assert.deepEqual(parsed.map((item) => item.postId), ['owned']);
  assert.equal(parsed[0].attachmentType, 'video');
  const foreign = extractContentPage(tabPage('community', { sectionListRenderer: { contents: [post('foreign', 'UC_OTHER')] } }), 'community');
  assert.equal(foreign.recognized, false);
  assert.equal(foreign.emptyConfirmed, false);
  assert.deepEqual(foreign.items, []);
  const continuation = extractContentPage(continuationPage([post('foreign', 'UC_OTHER')]), 'community', true, 'UC_OWNER');
  assert.equal(continuation.recognized, false);
});

test('append and reload continuations are scoped to one consistent channel feed', () => {
  const data = continuationPage([video('second'), token('NEXT_2')]);
  const page = extractContentPage(data, 'videos', true);
  assert.equal(page.recognized, true);
  assert.equal(page.continuationToken, 'NEXT_2');
  assert.deepEqual(extractVideos({ contents: page.items }).map((item) => item.videoId), ['second']);
  const reload = extractContentPage({ onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: {
    targetId: 'rich-grid', continuationItems: [video('reload')],
  } }] }, 'videos', true);
  assert.equal(reload.recognized, true);
  assert.equal(extractVideos({ contents: reload.items })[0].videoId, 'reload');
  data.onResponseReceivedActions.push({ appendContinuationItemsAction: { targetId: 'browse-feed', continuationItems: [video('third')] } });
  assert.equal(extractContentPage(data, 'videos', true).items.length, 2);
  data.onResponseReceivedActions.push({ appendContinuationItemsAction: { targetId: 'rich-grid', continuationItems: [video('different-feed')] } });
  const ambiguous = extractContentPage(data, 'videos', true);
  assert.equal(ambiguous.continuationAmbiguous, true);
  assert.equal(ambiguous.emptyConfirmed, false);
  assert.deepEqual(ambiguous.items, []);
});

test('recommendation and engagement continuation targets do not become channel content', () => {
  for (const target of ['comments-section', 'engagement-panel', 'browse-feedFEwhat_to_watch', 'related-videos', 'rich-grid-recommendations']) {
    const page = extractContentPage(continuationPage([video('foreign')], target), 'videos', true);
    assert.equal(page.recognized, false);
    assert.equal(page.emptyConfirmed, false);
    assert.deepEqual(page.items, []);
  }
});

test('legacy continuation containers expose only their own direct rows and nextContinuationData', () => {
  for (const [key, itemKey] of [['richGridContinuation', 'contents'], ['gridContinuation', 'items'], ['itemSectionContinuation', 'contents']]) {
    const page = extractContentPage({ continuationContents: { [key]: {
      [itemKey]: [video('legacy')], continuations: [{ nextContinuationData: { continuation: 'LEGACY_NEXT' } }],
    } }, header: token('HEADER_NEXT') }, 'videos', true);
    assert.equal(page.recognized, true);
    assert.equal(page.continuationToken, 'LEGACY_NEXT');
    assert.equal(page.items.length, 1);
  }
});

test('conflicting tokens are ambiguous; identical repeated tokens remain consistent', () => {
  const repeated = extractContentPage(richPage('videos', [video('owned'), token('NEXT'), token('NEXT')]), 'videos');
  assert.equal(repeated.continuationToken, 'NEXT');
  assert.equal(repeated.continuationAmbiguous, false);
  const conflict = extractContentPage(richPage('videos', [video('owned'), token('A'), token('B')]), 'videos');
  assert.equal(conflict.continuationToken, null);
  assert.equal(conflict.continuationAmbiguous, true);
  assert.equal(conflict.items.length, 1);
  assert.equal(extractContentPage(richPage('videos', [token('')]), 'videos').emptyConfirmed, false);
});

test('missing continuations and combined action/container regions never imply exhaustion', () => {
  assert.equal(extractContentPage({}, 'videos', true).emptyConfirmed, false);
  const combined = { ...continuationPage([video('action')]), continuationContents: { gridContinuation: { items: [video('container')] } } };
  assert.equal(extractContentPage(combined, 'videos', true).continuationAmbiguous, true);
  assert.equal(extractContentPage(continuationPage([]), 'videos', true).emptyConfirmed, true);
});

test('deep unsupported wrappers are bounded and retain incomplete coverage', () => {
  let content: any = video('too-deep');
  for (let index = 0; index < 30; index += 1) content = { richItemRenderer: { content } };
  const page = extractContentPage(richPage('videos', [content]), 'videos');
  assert.equal(page.recognized, false);
  assert.equal(page.emptyConfirmed, false);
  assert.equal(page.continuationAmbiguous, true);
});

test('modern lockup menu controls cannot invalidate a scoped video feed or its continuation', () => {
  // Distilled from the Oct 2 public /@mkbhd/videos layout: menu actions reached
  // depth 28 and thumbnail hover actions depth 21; neither is exported metadata.
  let controls: any = { signalServiceEndpoint: { actions: [{ addToPlaylistCommand: { videoCommand: {} } }] } };
  for (let index = 0; index < 30; index += 1) controls = { command: controls };
  const card = { lockupViewModel: {
    contentId: 'owned-modern', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: {
      image: { sources: [{ url: 'https://i.ytimg.com/owned.jpg' }] },
      overlays: [
        { thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '12:34' } }] } },
        { thumbnailHoverOverlayToggleActionsViewModel: controls },
      ],
    } },
    metadata: { lockupMetadataViewModel: {
      title: { content: 'Owned modern video' },
      metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [
        { text: { content: '12K views' } }, { text: { content: '2 days ago' } },
      ] }] } },
      menuButton: { buttonViewModel: { onTap: controls } },
    } },
    navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=owned-modern' } } },
  } };
  for (const continuation of [false, true]) {
    const data = continuation ? continuationPage([card, token('MODERN_NEXT')]) : richPage('videos', [card, token('MODERN_NEXT')]);
    const page = extractContentPage(data, 'videos', continuation, 'UC_OWNER');
    assert.equal(page.recognized, true);
    assert.equal(page.continuationAmbiguous, false);
    assert.equal(page.continuationToken, 'MODERN_NEXT');
    assert.deepEqual(extractVideos({ contents: page.items }), extractVideos({ contents: [card] }));
    assert.equal(extractVideos({ contents: page.items })[0].lengthText, '12:34');
    assert.doesNotMatch(JSON.stringify(page.items), /menuButton|thumbnailHoverOverlayToggleActionsViewModel|signalServiceEndpoint/);
  }
});

test('community carousel retains the original first public image without nested suggested content', () => {
  // Public posts use postMultiImageRenderer.images[].backstageImageRenderer.
  const post = { backstagePostThreadRenderer: { post: { backstagePostRenderer: {
    postId: 'owned-carousel', authorEndpoint: { browseEndpoint: { browseId: 'UC_OWNER' } },
    contentText: { simpleText: 'Public gallery' },
    backstageAttachment: { postMultiImageRenderer: { images: [
      { backstageImageRenderer: { image: { thumbnails: [
        { url: 'https://yt3.ggpht.com/first-small.jpg' }, { url: 'https://yt3.ggpht.com/first-large.jpg' },
      ] }, recommendations: video('suggested-video') } },
      { backstageImageRenderer: { image: { thumbnails: [{ url: 'https://yt3.ggpht.com/second.jpg' }] } } },
      { videoRenderer: { videoId: 'not-an-image' } },
    ], recommendations: [{ backstagePostRenderer: { postId: 'suggested-post' } }] } },
  } }, replies: [{ backstagePostRenderer: { postId: 'reply' } }] } };
  for (const continuation of [false, true]) {
    const data = continuation ? continuationPage([post]) : tabPage('community', {
      sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [post] } }] },
    });
    const page = extractContentPage(data, 'community', continuation, 'UC_OWNER');
    assert.equal(page.recognized, true);
    assert.equal(page.continuationAmbiguous, false);
    const posts = extractCommunityPosts({ contents: page.items });
    assert.deepEqual(posts.map(item => item.postId), ['owned-carousel']);
    assert.equal(posts[0].attachmentType, 'image');
    assert.equal(posts[0].imageUrl, 'https://yt3.ggpht.com/first-large.jpg');
    assert.equal(posts[0].attachmentUrl, null);
    assert.deepEqual(extractVideos({ contents: page.items }), []);
    assert.doesNotMatch(JSON.stringify(page.items), /suggested-video|suggested-post|not-an-image|reply/);
  }
});

test('actual oversized or deep metadata still stops at the existing parser guards', () => {
  let metadata: any = { text: 'Unknown deeply nested metadata' };
  for (let index = 0; index < 30; index += 1) metadata = { data: metadata };
  const deep = extractContentPage(richPage('videos', [video('owned', { metadata }), token('NEXT')]), 'videos');
  assert.equal(deep.recognized, false);
  assert.equal(deep.continuationAmbiguous, true);
  assert.equal(deep.continuationToken, null);
  const large = extractContentPage(richPage('videos', [video('owned', { title: { runs: Array.from({ length: 21_000 }, () => ({ text: 'x' })) } })]), 'videos');
  assert.equal(large.recognized, false);
  assert.equal(large.continuationAmbiguous, true);
  assert.equal(large.emptyConfirmed, false);
});

test('opaque continuation target must match the verified initial feed exactly', () => {
  const feedId = '6ca61772-0000-2598-b377-10d9a20643c3';
  const fixture = richPage('videos', [video('first'), token('NEXT')]);
  Object.assign(fixture.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer, { targetId: feedId });
  const first = extractContentPage(fixture, 'videos', false, 'UC_OWNER');
  assert.equal(first.recognized, true);
  assert.equal(first.continuationTargetId, feedId);
  const next = continuationPage([video('second'), token('NEXT_2')], feedId);
  assert.equal(extractContentPage(next, 'videos', true, 'UC_OWNER').recognized, false);
  const bound = extractContentPage(next, 'videos', true, 'UC_OWNER', first.continuationTargetId);
  assert.equal(bound.recognized, true);
  assert.equal(bound.continuationTargetId, feedId);
  assert.deepEqual(extractVideos({ contents: bound.items }).map(row => row.videoId), ['second']);
  for (const wrong of ['another-opaque-feed', 'comments-section', 'browse-feedUC_OTHER', 'browse-feedUC_OWNERplaylists104']) {
    const rejected = extractContentPage(continuationPage([video('wrong')], wrong), 'videos', true, 'UC_OWNER', feedId);
    assert.equal(rejected.recognized, false, wrong);
    assert.equal(rejected.emptyConfirmed, false, wrong);
    assert.deepEqual(rejected.items, [], wrong);
  }
});

test('unsafe initial target identities and conflicting token-to-feed bindings fail closed', () => {
  for (const unsafe of ['comments-section', 'browse-feedUC_OTHER', 'browse-feedUC_OWNERshorts104', 'x'.repeat(257)]) {
    const fixture = richPage('videos', [video('owned'), token('NEXT')]);
    Object.assign(fixture.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer, { targetId: unsafe });
    const page = extractContentPage(fixture, 'videos', false, 'UC_OWNER');
    assert.equal(page.recognized, false, unsafe);
    assert.equal(page.continuationAmbiguous, true, unsafe);
    assert.equal(page.continuationToken, null, unsafe);
  }
  const conflict = tabPage('videos', { sectionListRenderer: { contents: [
    { gridRenderer: { targetId: 'feed-A', items: [video('a'), token('SHARED')] } },
    { gridRenderer: { targetId: 'feed-B', items: [video('b'), token('SHARED')] } },
  ] } });
  assert.equal(extractContentPage(conflict, 'videos').continuationAmbiguous, true);
  assert.equal(extractContentPage(conflict, 'videos').continuationTargetId, null);
});

test('public show collections become playlists only with a matching public destination', () => {
  const show = { lockupViewModel: {
    contentId: 'PL_SHOW', contentType: 'LOCKUP_CONTENT_TYPE_SHOW',
    contentImage: { collectionThumbnailViewModel: { primaryThumbnail: {
      thumbnailViewModel: { image: { sources: [{ url: 'https://i.ytimg.com/show.jpg' }] } },
    } } },
    metadata: { lockupMetadataViewModel: { title: { content: 'Owned show' },
      metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: '12 episodes' } }] }] } } } },
    rendererContext: { commandContext: { onTap: { innertubeCommand: {
      commandMetadata: { webCommandMetadata: { url: '/show/VLPL_SHOW?sbp=public-playback-parameter' } },
      browseEndpoint: { browseId: 'VLPL_SHOW' },
    } } } },
  } };
  const page = extractContentPage(richPage('playlists', [show]), 'playlists');
  assert.equal(page.recognized, true);
  assert.deepEqual(extractPlaylists({ contents: page.items }), [{
    playlistId: 'PL_SHOW', title: 'Owned show', videoCountText: '12 episodes', thumbnailUrl: 'https://i.ytimg.com/show.jpg',
  }]);
  for (const url of ['/show/VLPL_OTHER', 'https://evil.example/show/VLPL_SHOW']) {
    const foreign = structuredClone(show);
    const command = foreign.lockupViewModel.rendererContext.commandContext.onTap.innertubeCommand;
    command.browseEndpoint.browseId = 'VLPL_OTHER';
    command.commandMetadata.webCommandMetadata.url = url;
    const parsed = extractContentPage(richPage('playlists', [foreign]), 'playlists');
    assert.equal(parsed.recognized, false, url);
    assert.deepEqual(parsed.items, [], url);
  }
});
