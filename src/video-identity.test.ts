import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractVideoDetails, extractPlayerResponse, fetchYouTubePlayerData, publicVideoId } from './youtube-http.js';
import { detailFailureCategory } from './detail-failure.js';

test('conflicting player, current endpoint and public canonical video IDs are rejected', () => {
  assert.throws(() => extractVideoDetails({}, '', { videoDetails: { videoId: 'OTHER', title: 'Wrong' } }, 'OWNED'), /different video/);
  assert.throws(() => extractVideoDetails({ currentVideoEndpoint: { watchEndpoint: { videoId: 'OTHER' } } }, '', undefined, 'OWNED'), /different video/);
  assert.throws(() => extractVideoDetails({}, '<meta property="og:url" content="https://www.youtube.com/watch?v=OTHER">', undefined, 'OWNED'), /different video/);
  assert.throws(() => extractVideoDetails({}, '', { microformat: { playerMicroformatRenderer: { publishDate: '2026-10-01' } } }, 'OWNED'), /did not confirm/);
});

test('identified complete players enrich rows but unpaired fallback snippets do not', () => {
  const player = { videoDetails: { videoId: 'OWNED', title: 'Owned' }, microformat: { playerMicroformatRenderer: { publishDate: '2026-10-01' } } };
  const correct = extractVideoDetails({}, '', player, 'OWNED');
  assert.equal(correct.title, 'Owned');
  assert.equal(correct.publishedDate, '2026-10-01');
  const html = `<script>${JSON.stringify({ videoDetails: { videoId: 'OTHER', title: 'Unpaired recommendation' }, microformat: { playerMicroformatRenderer: { publishDate: '2026-01-01' } } })}</script>`;
  const fallback = extractVideoDetails({}, html, undefined, 'OWNED');
  assert.equal(fallback.title, null);
  assert.equal(fallback.publishedDate, null);
});

test('video ID parsing accepts public routes and refuses foreign hosts', () => {
  assert.equal(publicVideoId('/watch?v=OWNED'), 'OWNED');
  assert.equal(publicVideoId('https://www.youtube.com/shorts/OWNED'), 'OWNED');
  assert.equal(publicVideoId('https://www.youtube.com/live/OWNED'), 'OWNED');
  assert.equal(publicVideoId('https://example.com/watch?v=OWNED'), null);
});

test('missing player config and unconfirmed identity expose distinct safe detail codes', async () => {
  await assert.rejects(fetchYouTubePlayerData('OWNED', '<html>no configuration</html>'), (error) => {
    assert.equal(detailFailureCategory(error), 'player-config-missing');
    return true;
  });
  for (const [player, expected] of [
    [{ videoDetails: { videoId: 'OTHER' } }, 'video-identity-mismatch'],
    [{ microformat: { playerMicroformatRenderer: { publishDate: '2026-10-01' } } }, 'video-identity-unconfirmed'],
  ] as const) {
    assert.throws(() => extractVideoDetails({}, '', player, 'OWNED'), (error) => {
      assert.equal(detailFailureCategory(error), expected);
      return true;
    });
  }
});

test('a matching full player is selected instead of a richer foreign player; metadata is never combined', () => {
  const owned = { videoDetails: { videoId: 'OWNED', title: 'Owned' },
    microformat: { playerMicroformatRenderer: { publishDate: '2026-10-01' } } };
  const other = { videoDetails: { videoId: 'OTHER', title: 'Other', keywords: ['WRONG'], shortDescription: 'WRONG' },
    microformat: { playerMicroformatRenderer: { category: 'WRONG', publishDate: '2026-09-01' } } };
  const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(owned)};</script>`
    + `<script>var ytInitialPlayerResponse = ${JSON.stringify(other)};</script>`;
  assert.equal(extractPlayerResponse(html, 'OWNED').videoDetails.videoId, 'OWNED');
  const details = extractVideoDetails({}, html, undefined, 'OWNED');
  assert.equal(details.publishedDate, '2026-10-01');
  assert.equal(details.category, null);
  assert.deepEqual(details.tags, []);
});

function verifiedWatch(dateText: string, currentId = 'OWNED') {
  return { currentVideoEndpoint: { watchEndpoint: { videoId: currentId } },
    contents: { twoColumnWatchNextResults: { results: { results: { contents: [
      { videoPrimaryInfoRenderer: { dateText: { simpleText: dateText } } },
    ] } }, secondaryResults: { videoPrimaryInfoRenderer: { dateText: { simpleText: 'Jan 1, 1990' } } } } } };
}

test('the verified main watch date provides only a known calendar day when player metadata is absent', () => {
  for (const [label, date] of [['Sep 30, 2026', '2026-09-30'], ['September 28, 2026', '2026-09-28'],
    ['Streamed live on Feb 29, 2024', '2024-02-29']] as const) {
    assert.equal(extractVideoDetails(verifiedWatch(label), '', undefined, 'OWNED').publishedDate, date);
  }
  const notAWatchPage = { currentVideoEndpoint: { watchEndpoint: { videoId: 'OWNED' } },
    arbitraryRecommendation: { videoPrimaryInfoRenderer: { dateText: { simpleText: 'Sep 30, 2026' } } } };
  assert.equal(extractVideoDetails(notAWatchPage, '', undefined, 'OWNED').publishedDate, null);
  const unverified = verifiedWatch('Sep 30, 2026');
  delete (unverified as any).currentVideoEndpoint;
  assert.equal(extractVideoDetails(unverified, '', undefined, 'OWNED').publishedDate, null);
});

test('invalid, relative and localized watch dates stay unknown and exact player timestamps take precedence', () => {
  for (const label of ['Feb 30, 2026', 'Feb 29, 2025', 'Sep 0, 2026', '1d ago', '30 Sep 2026', '09/30/2026']) {
    assert.equal(extractVideoDetails(verifiedWatch(label), '', undefined, 'OWNED').publishedDate, null, label);
  }
  const player = { videoDetails: { videoId: 'OWNED' },
    microformat: { playerMicroformatRenderer: { publishDate: '2026-09-30T07:42:19-07:00' } } };
  assert.equal(extractVideoDetails(verifiedWatch('Sep 30, 2026'), '', player, 'OWNED').publishedDate,
    '2026-09-30T07:42:19-07:00');
  assert.throws(() => extractVideoDetails(verifiedWatch('Sep 30, 2026', 'OTHER'), '', undefined, 'OWNED'), /different video/);
});
