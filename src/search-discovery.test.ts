import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSearchChannelUrls } from './youtube-http.js';

test('search row limits count channels, not two aliases for the same channel', () => {
  const channel = (channelId: string, url?: string) => ({ channelRenderer: {
    channelId, navigationEndpoint: url ? { commandMetadata: { webCommandMetadata: { url } } } : undefined,
  } });
  const data = { contents: [channel('UC_ONE', '/@one'), channel('UC_ONE', '/channel/UC_ONE'), channel('UC_TWO', '/@two')] };
  assert.deepEqual(extractSearchChannelUrls(data, 2), ['https://www.youtube.com/@one', 'https://www.youtube.com/@two']);
  assert.deepEqual(extractSearchChannelUrls({ contents: [channel('UC_FALLBACK'), channel('UC_TWO', '/@two')] }, 2),
    ['https://www.youtube.com/channel/UC_FALLBACK', 'https://www.youtube.com/@two']);
});
