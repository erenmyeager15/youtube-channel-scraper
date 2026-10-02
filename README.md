# YouTube Scraper: Channels, Shorts, Live & Posts

Use optional publication windows and bounded pagination to collect relevant public content, then inspect the coverage summary to see exactly where collection stopped.

Track competitor and creator channels from one dataset. Scrape public channel stats, recent videos, Shorts, live streams, playlists, channel-authored community posts, websites, and social profiles without a YouTube login or API key.

The Actor uses bounded HTTP requests to read public YouTube pages and parses YouTube's embedded public data. It returns only fields YouTube exposes publicly and marks unavailable fields as `null`.

**Price:** $3 per 1,000 successfully saved channels on the FREE Store tier, with discounts down to $2.55 per 1,000. One channel charge includes all selected content rows—there is no separate charge for each video, Short, playlist, or post. A one-channel run is approximately $0.00305 including the minimum start event.

**Best for:** competitor publishing trackers, creator research tables, channel watchlists, and recurring reports. The default reads one public content page per selected tab; opt-in pagination remains bounded and is not a full historical export of every upload.

## Track a competitor channel

This low-cost first run creates one channel row plus up to five recent videos, five Shorts, and three community posts:

```json
{
  "channelUrls": [
    "https://www.youtube.com/@mkbhd"
  ],
  "mode": "fast",
  "maxVideosPerChannel": 5,
  "includeShorts": true,
  "maxShortsPerChannel": 5,
  "includeCommunityPosts": true,
  "maxCommunityPostsPerChannel": 3
}
```

Schedule the same input daily or weekly, then compare `subscriberCountNumber`, `totalVideoCountNumber`, recent titles, views, and publishing dates in your spreadsheet or dashboard. Add more direct channel URLs to build a watchlist.

## Enrich a creator profile

Switch to detailed mode when you also need public websites, classified social profiles, About-page details, and exact engagement fields for selected recent videos:

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

If direct detailed metadata is withheld by a confirmed YouTube automation check, you can explicitly set `"metadataProxyFallback": true`. This uses Apify Residential only for compact player metadata, not full pages or video/audio files. It requires Residential access and adds proxy usage costs. It is disabled by default and must not be combined with full-page `proxyConfiguration`. Availability is still source-dependent; inspect `RUN-SUMMARY.metadataFallback` and detailed failures rather than assuming every field was returned.

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
- `sourceDateText`, `publishedAt`, `publishedAtPrecision`, earliest/latest publication bounds, and `publicationWindowMatch`. Relative ages are approximate intervals, never exact timestamps; missing dates remain unknown.
- Detailed mode can retain a video-ID-verified calendar date from the main watch page when the player timestamp is unavailable. This stays day-level precision; it is not an invented upload time.
- Thumbnail URL
- Content classification as `video`, `short`, or `live_stream`
- Live status when YouTube exposes it
- Extraction timestamp
- In detailed mode for the selected latest videos: exact public views, likes, description, tags, category, exact publish date, and public comment count when YouTube exposes a number

### Playlist rows

- Playlist URL, ID, title, thumbnail, and public video count
- Channel URL and channel name
- Extraction timestamp

The Playlists tab may also contain show-style collections. These are saved as playlist rows only when their public destination confirms the same playlist ID; unrelated show or recommendation cards are excluded.

### Community-post rows

- Post URL, ID, channel-authored public text, thumbnail or attachment URL
- Published-date text and public like/comment counts when YouTube exposes them
- The same publication precision and window-match fields as video rows
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

`RUN-SUMMARY` in the default key-value store reports each requested tab's inspected pages, rows seen/selected/saved, excluded rows, date uncertainty, remaining-page signal and stop reason. Failed detailed requests carry fixed stage/category codes and, when available, a recognized public `playerStatus` such as `LOGIN_REQUIRED`; never raw source errors, response bodies, anonymous visitor values, API keys or proxy URLs. This report is separate from the dataset and adds no channel charge. Disabled tabs are omitted. `complete` means a recognized feed ended without a cap, parsing/fetch failure or uncertain date eligibility; it is not a guarantee that YouTube exposed all content or every optional field. A successful run can still have incomplete coverage.

## Bounded publication-window collection

```json
{
  "channelUrls": ["https://www.youtube.com/@mkbhd"],
  "mode": "fast",
  "maxVideosPerChannel": 25,
  "maxPagesPerSection": 3,
  "maxRequestsPerChannel": 15,
  "publishedAfter": "2026-09-01",
  "publishedBefore": "2026-09-30"
}
```

Date-only inputs include the entire UTC day. Timestamp inputs must include a timezone. Videos, Shorts, live streams and community posts are excluded only when their known date or approximate interval is wholly outside the window. Unknown dates and boundary overlaps stay in the output with `publicationWindowMatch: "uncertain"`; filter these explicitly if your workflow requires certain matches. Upcoming streams may have unknown publication dates. Playlists have no reliable public publication date here and are not date-filtered.

Date filtering does not assume chronological ordering or stop at the first old card: pinned and reordered items can appear later. It does not guarantee a target number of matching rows. Detailed-mode dates may exclude a previously uncertain selected row; the scraper does not perform unbounded refill requests. The existing channel charge applies when channel metadata is saved, even if no content matches your window.

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
| `maxVideosPerChannel` | integer | `1` | Maximum selected rows from inspected public Videos pages, from 1 to 100 |
| `maxPagesPerSection` | integer | `1` | Initial page plus public continuations, 1–5 pages per selected content tab |
| `maxRequestsPerChannel` | integer | `30` | Shared source HTTP-attempt cap, 1–50, including retries, redirects, initial/About/tab/detail/player and continuation requests |
| `publishedAfter` / `publishedBefore` | string | Disabled | Inclusive UTC dates or timezone-qualified timestamps; uncertain dates stay visible |
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

Failed channel extractions and duplicate channel aliases are not charged as `channel-scraped` events. When a maximum-cost limit is reached, the Actor completes the bounded available content bundle for a successfully saved current channel, then skips queued channel work. A rejected channel save does not trigger its content requests. This event-charge limit is not a hard cap on platform execution, proxy or build costs.

## Limits and reliability

- YouTube changes its page structure regularly. Select fields may temporarily become unavailable.
- Subscriber counts can be hidden or abbreviated.
- Search results depend on region and YouTube ranking.
- Fast runs are capped at 50 unique channels. Detailed runs are capped at 10 channels and 5 enriched video pages per channel. Requests are sequential and use bounded retries.
- Optional Shorts, Live, Playlists and Posts share one per-channel attempt budget. They use one page by default and follow at most five pages when explicitly requested. A channel may not expose every tab; a missing/unsupported tab is incomplete, not a confirmed empty feed.
- Pagination uses public browse configuration and scoped channel-feed continuation tokens. It stops at row/page/request limits, repeated tokens, no progress, unavailable data or ambiguous response structure. It never follows recommendations, comments or engagement-panel continuations.
- Each channel's source collection has a 240-second deadline; each request is limited to 30 seconds or the remaining deadline, and each decoded response to 8 MiB. These are defensive bounds, not a guaranteed run-time, memory or spending cap. Searches have a separate four-attempt/120-second budget per keyword.
- Additional pages and detailed fields require more source requests. Channel event prices are unchanged; choose modest row/page/request limits for recurring watchlists. Optional proxies and account-level charges may add costs.
- Shorts detection prefers YouTube's explicit `/shorts/` route. Duration is only a fallback because Shorts can now be up to three minutes and ordinary videos can be shorter than one minute.
- If a channel page succeeds but its Videos tab is unavailable, the Actor saves and charges the channel metadata row without fabricating video rows.
- Public like and comment totals are not present in every YouTube page payload. When YouTube exposes a label without a number, count fields remain `null`.
- Community output contains only posts authored by the selected public channel. It does not collect commenter identities or comment text.
- Detailed fields are public page data, not private analytics, and can be hidden or changed by YouTube or the channel owner.
- An anonymous cloud player request may return `LOGIN_REQUIRED` even when the public watch page is readable. The Actor retains verified watch-page fields and reports missing details; it does not use account login cookies, invent category/tags, or automatically enable a paid proxy. A proxy is optional and does not guarantee access.
- A confirmed "not a bot" player response is reported as `source-automation-check`. Further player API calls in that channel session stop, while available watch-page fields and other bounded public content collection remain eligible. This does not mark missing details as complete. A new channel budget is independent; generic sign-in or video-specific restrictions are not treated as a session-wide automation block.
- The opt-in metadata fallback allows one Residential attempt per selected detailed video, at most five per channel. It stops paid attempts for that channel after a fallback failure. Compact responses are bounded to 32 KiB each and 64 KiB of successfully read decoded bodies per channel, with no redirects. Network overhead, provider setup and bytes received before an oversized response is cut off mean these are not guaranteed traffic or spending caps. A proxy failure never enables another provider, full-page proxying, login cookies or extra retries.
- Requests within one channel collection reuse an anonymous browser-header session and, when a proxy was explicitly selected, the same proxy session ID. Proxy setup is deadline-bounded; a failed selected proxy does not silently switch to a direct request. Provider session expiry or interruption can still change the connection.
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
