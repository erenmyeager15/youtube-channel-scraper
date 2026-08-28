# YouTube Scraper: Channels, Shorts, Live & Posts

Scrape public YouTube channels, videos, Shorts, live streams, playlists, and channel-authored community posts without a YouTube login or API key. Provide channel URLs, `@handles`, or search keywords, select only the content you need, and choose fast monitoring or richer detailed enrichment.

The Actor uses bounded HTTP requests to read public YouTube pages and parses YouTube's embedded public data. It returns only fields YouTube exposes publicly and marks unavailable fields as `null`.

## Quick start

Run one channel with a small mix of public content:

```json
{
  "channelUrls": [
    "https://www.youtube.com/@mkbhd"
  ],
  "searchKeywords": [],
  "mode": "fast",
  "maxChannels": 1,
  "maxVideosPerChannel": 1,
  "maxDetailedVideosPerChannel": 1,
  "includeShorts": true,
  "maxShortsPerChannel": 2,
  "includeLiveStreams": false,
  "includePlaylists": true,
  "maxPlaylistsPerChannel": 2,
  "includeCommunityPosts": true,
  "maxCommunityPostsPerChannel": 2,
  "proxyConfiguration": {
    "useApifyProxy": false
  }
}
```

For richer creator research, switch to detailed mode:

```json
{
  "channelUrls": ["https://www.youtube.com/@mkbhd"],
  "mode": "detailed",
  "maxVideosPerChannel": 5,
  "maxDetailedVideosPerChannel": 2,
  "includeShorts": true,
  "maxShortsPerChannel": 5,
  "includeLiveStreams": true,
  "maxLiveStreamsPerChannel": 5,
  "includePlaylists": true,
  "maxPlaylistsPerChannel": 5,
  "includeCommunityPosts": true,
  "maxCommunityPostsPerChannel": 5
}
```

Export the results as JSON, CSV, Excel, XML, or HTML, or consume them through the Apify API, schedules, webhooks, Make, Zapier, n8n, and other integrations.

## What it extracts

### Channel rows

- Channel URL, channel ID, name, and handle
- Direct public URLs for the Videos, Shorts, Live Streams, Playlists, and Community tabs
- Subscriber count as displayed and as a parsed number
- Total video count as displayed and as a parsed number
- Public channel description with contact details redacted
- Avatar and banner image URLs when available
- Verified-channel flag
- Extraction timestamp
- In detailed mode: total channel views, join date, country, named website links, and classified social/community profiles, including Facebook, Instagram, LinkedIn, X, YouTube, TikTok, Reddit, Twitch, Threads, and Discord
- The backward-compatible `socialLinks` array still contains all accepted public external URLs; email addresses and email links are excluded

### Video, Shorts, and live-stream rows

- Channel URL and channel name
- Video URL and title
- View count as displayed and as a parsed number
- Duration in seconds and formatted text
- Relative published date shown by YouTube
- Thumbnail URL
- Content classification as `video`, `short`, or `live_stream`
- Live status when YouTube exposes it
- Extraction timestamp
- In detailed mode for the selected latest videos: exact public views, likes, description, tags, category, exact publish date, and public comment count when YouTube exposes a number

### Playlist rows

- Playlist URL, ID, title, thumbnail, and public video count
- Channel URL and channel name
- Extraction timestamp

### Community-post rows

- Post URL, ID, channel-authored public text, thumbnail or attachment URL
- Published-date text and public like/comment counts when YouTube exposes them
- Channel URL and channel name
- Extraction timestamp

Fast mode collects selected content grids efficiently and leaves detailed-only fields as `null`, empty arrays, or an empty social-profile object. Detailed mode enriches the About page and a bounded number of normal video pages. If one optional tab or video page cannot be read, the Actor still saves the available records instead of fabricating data.

## Output dataset

One run can write four record types to the default dataset:

- The `Channels` view shows channel-level records.
- The `Videos` view shows normal videos, Shorts, and live-stream records.
- The `Playlists` view shows playlist records.
- The `Community posts` view shows channel-authored post records.
- Every row has an explicit `recordType` field for reliable filtering.

### Verified channel sample

This shortened sample comes from a successful public Actor run:

```json
{
  "channelUrl": "https://www.youtube.com/@mkbhd",
  "channelName": "Marques Brownlee",
  "handle": "@mkbhd",
  "subscriberCount": "21M subscribers",
  "subscriberCountNumber": 21000000,
  "totalVideoCount": "1.8K videos",
  "totalVideoCountNumber": 1800,
  "isVerified": true,
  "scrapedAt": "2026-06-22T07:56:07.305Z"
}
```

### Verified video sample

```json
{
  "channelUrl": "https://www.youtube.com/@mkbhd",
  "channelName": "Marques Brownlee",
  "videoUrl": "https://www.youtube.com/watch?v=WOzcFkld6_g",
  "videoTitle": "The Most Interesting Displays In The World!",
  "viewCount": "2.3M views",
  "viewCountNumber": 2300000,
  "durationSeconds": 957,
  "durationFormatted": "15:57",
  "publishedDate": "5 days ago",
  "isShorts": false,
  "scrapedAt": "2026-06-22T07:56:11.022Z"
}
```

Counts, titles, thumbnails, and relative dates can change when YouTube updates the page.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `channelUrls` | array | One sample channel | Up to 50 full YouTube channel URLs or `@handles` |
| `searchKeywords` | array | Empty | Up to 10 optional keywords used to discover channels |
| `mode` | string | `fast` | `fast` for low-request monitoring or `detailed` for About and selected video-page fields |
| `maxChannels` | integer | `1` | Maximum channels scraped per search keyword, from 1 to 50 |
| `maxVideosPerChannel` | integer | `1` | Maximum latest rows saved from the currently loaded public Videos grid, from 1 to 100 |
| `maxDetailedVideosPerChannel` | integer | `1` | Detailed mode only: enrich the first 0 to 5 saved video rows per channel |
| `includeShorts` | boolean | `false` | Read the public Shorts tab and save Shorts as separate video records |
| `maxShortsPerChannel` | integer | `10` | Maximum Shorts saved per channel, from 1 to 50 |
| `includeLiveStreams` | boolean | `false` | Read the public Live tab and save past, upcoming, or active streams |
| `maxLiveStreamsPerChannel` | integer | `10` | Maximum live-stream rows saved per channel, from 1 to 50 |
| `includePlaylists` | boolean | `false` | Read the public Playlists tab and save playlist records |
| `maxPlaylistsPerChannel` | integer | `10` | Maximum playlists saved per channel, from 1 to 50 |
| `includeCommunityPosts` | boolean | `false` | Read the public Posts tab and save channel-authored community posts |
| `maxCommunityPostsPerChannel` | integer | `10` | Maximum community posts saved per channel, from 1 to 50 |
| `proxyConfiguration` | object | Direct | Optional Apify Proxy, country, custom-proxy, or direct settings |

Provide at least one channel URL, handle, or search keyword. Direct channel inputs are more predictable than keyword search. Search results vary by region and ranking. Fast mode handles at most 50 unique channels per run. Detailed mode handles at most 10 channels and enriches at most 5 video rows per channel.

## Common workflows

### Monitor selected channels

Use direct channel URLs, schedule repeated runs, and compare subscriber counts, video counts, and latest-video rows over time.

### Build a creator research table

Use detailed mode to collect public channel size, total views, country, websites, classified social profiles, descriptions, and recent video engagement for a defined set of channels.

### Track competitor publishing

Compare latest titles, view counts, durations, and relative publish times across competing channels in the same niche.

### Create recurring reports

Send dataset rows to a spreadsheet, warehouse, dashboard, or workflow tool through Apify integrations.

## Pricing

This Actor uses Pay Per Event pricing.

| Event | Price |
| --- | ---: |
| Actor start | $0.00005 per GB of memory |
| Each successfully saved `channel-scraped` channel | $0.003, with Store-tier discounts down to $0.00255 |

The Actor defaults to 256 MB of memory and can be raised to 1 GB for larger batches. Actor-start billing uses a minimum of one event, so the startup charge remains approximately $0.00005 per run at the default memory. All selected content rows are included in the channel charge—there is no extra per-video, per-Short, per-playlist, or per-post event fee. A one-channel run on the FREE Store tier is therefore approximately $0.00305 before any applicable account-level charges.

Failed channel extractions and duplicate channel aliases are not charged as `channel-scraped` events. When a maximum-cost limit is reached, the Actor finishes cleanly after storing the current paid channel and its available video rows, then skips queued channel work.

## Limits and reliability

- YouTube changes its page structure regularly. Select fields may temporarily become unavailable.
- Subscriber counts can be hidden or abbreviated.
- Search results depend on region and YouTube ranking.
- Fast runs are capped at 50 unique channels. Detailed runs are capped at 10 channels and 5 enriched video pages per channel. Requests are sequential and use bounded retries.
- Optional Shorts, Live, Playlists, and Posts sections each use one bounded public-tab request per channel. A channel may not expose every tab.
- Content tabs currently read YouTube's initially loaded public grid. The Actor does not yet follow continuation pages, so the configured maximum is also bounded by what YouTube includes in that first response.
- Shorts detection prefers YouTube's explicit `/shorts/` route. Duration is only a fallback because Shorts can now be up to three minutes and ordinary videos can be shorter than one minute.
- If a channel page succeeds but its Videos tab is unavailable, the Actor saves and charges the channel metadata row without fabricating video rows.
- Public like and comment totals are not present in every YouTube page payload. When YouTube exposes a label without a number, count fields remain `null`.
- Community output contains only posts authored by the selected public channel. It does not collect commenter identities or comment text.
- Detailed fields are public page data, not private analytics, and can be hidden or changed by YouTube or the channel owner.
- External-link classification recognizes Facebook, Instagram, LinkedIn, X/Twitter, YouTube, TikTok, Reddit, Twitch, Threads, and Discord; other accepted HTTP(S) links are returned as websites.
- Email addresses and `mailto:` links are not collected. Email addresses and phone numbers found in public descriptions are redacted.
- The Actor reads public pages only and does not access YouTube Studio, private analytics, account data, or private videos.

## API example

```bash
curl -X POST "https://api.apify.com/v2/acts/fascinating_lentil~youtube-channel-scraper/runs?token=YOUR_APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channelUrls": ["https://www.youtube.com/@mkbhd"],
    "searchKeywords": [],
    "mode": "detailed",
    "maxChannels": 1,
    "maxVideosPerChannel": 3,
    "maxDetailedVideosPerChannel": 1,
    "includeShorts": true,
    "maxShortsPerChannel": 3,
    "includeLiveStreams": true,
    "maxLiveStreamsPerChannel": 3,
    "includePlaylists": true,
    "maxPlaylistsPerChannel": 3,
    "includeCommunityPosts": true,
    "maxCommunityPostsPerChannel": 3,
    "proxyConfiguration": {"useApifyProxy": false}
  }'
```

## Responsible use

Use this Actor only for lawful collection of publicly available information. You are responsible for complying with YouTube's terms, copyright rules, privacy laws, and regulations that apply to your use case.

Do not use the output for spam, harassment, profiling, or unlawful collection of personal data. This Actor is an independent tool and is not affiliated with, endorsed by, or sponsored by YouTube or Google.

## License

Apache-2.0.
