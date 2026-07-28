# YouTube Channel Scraper

Scrape public YouTube channel stats and latest-video summaries without a YouTube login or API key. Provide channel URLs, `@handles`, or search keywords and receive structured channel and video rows for monitoring, research, reporting, and automation.

The Actor uses a browser to read public YouTube channel pages. It returns the fields YouTube exposes on those pages and marks unavailable fields as `null`.

## Quick start

Run one channel with one latest video:

```json
{
  "channelUrls": [
    "https://www.youtube.com/@mkbhd"
  ],
  "searchKeywords": [],
  "maxChannels": 1,
  "maxVideosPerChannel": 1,
  "includeShorts": false,
  "proxyConfiguration": {
    "useApifyProxy": false
  }
}
```

Export the results as JSON, CSV, Excel, XML, or HTML, or consume them through the Apify API, schedules, webhooks, Make, Zapier, n8n, and other integrations.

## What it extracts

### Channel rows

- Channel URL, name, and handle
- Subscriber count as displayed and as a parsed number
- Total video count as displayed and as a parsed number
- Public channel description with contact details redacted
- Avatar and banner image URLs when available
- Verified-channel flag
- Extraction timestamp

### Latest-video rows

- Channel URL and channel name
- Video URL and title
- View count as displayed and as a parsed number
- Duration in seconds and formatted text
- Relative published date shown by YouTube
- Thumbnail URL
- Shorts detection
- Extraction timestamp

The dataset schema retains additional nullable fields for compatibility. The active fast channel-grid path does not currently populate total channel views, join date, country, social links, video likes, comments, descriptions, tags, or categories.

## Output dataset

One run writes both record types to the default dataset:

- The `Channels` view shows channel-level records.
- The `Videos` view shows the latest-video records.
- A video row can be identified by the presence of `videoUrl`.

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
| `maxChannels` | integer | `1` | Maximum channels scraped per search keyword, from 1 to 50 |
| `maxVideosPerChannel` | integer | `1` | Maximum latest rows saved from the currently loaded public Videos grid, from 1 to 100 |
| `includeShorts` | boolean | `false` | Include videos detected as Shorts from YouTube routing, with duration used only as a fallback |
| `proxyConfiguration` | object | Direct | Optional Apify Proxy, country, custom-proxy, or direct settings |

Provide at least one channel URL, handle, or search keyword. Direct channel inputs are more predictable than keyword search. Search results vary by region and ranking. A run handles at most 50 unique channel pages across direct and search-discovered inputs.

## Common workflows

### Monitor selected channels

Use direct channel URLs, schedule repeated runs, and compare subscriber counts, video counts, and latest-video rows over time.

### Build a creator research table

Collect public channel size, verified status, descriptions, and recent video performance for a defined set of channels.

### Track competitor publishing

Compare latest titles, view counts, durations, and relative publish times across competing channels in the same niche.

### Create recurring reports

Send dataset rows to a spreadsheet, warehouse, dashboard, or workflow tool through Apify integrations.

## Pricing

This Actor uses Pay Per Event pricing.

| Event | Price |
| --- | ---: |
| Actor start | $0.00005 per GB of memory |
| Each successfully saved `channel-scraped` channel | $0.003 |

The Actor defaults to 1 GB of memory and can be raised to 2 GB for larger batches. At the default memory, the startup charge is approximately $0.00005 per run. Available latest-video rows are included in the channel charge. A one-channel run is therefore approximately $0.00305 before any applicable account-level charges.

Failed channel extractions and duplicate channel aliases are not charged as `channel-scraped` events. When a maximum-cost limit is reached, the Actor finishes cleanly after storing the current paid channel and its available video rows, then skips queued channel work.

## Limits and reliability

- YouTube changes its page structure regularly. Select fields may temporarily become unavailable.
- Subscriber counts can be hidden or abbreviated.
- Search results depend on region and YouTube ranking.
- Runs are capped at 50 unique channel pages and three concurrent browser handlers. Begin with small batches to reduce rate limiting.
- Shorts detection prefers YouTube's explicit `/shorts/` route. Duration is only a fallback because Shorts can now be up to three minutes and ordinary videos can be shorter than one minute.
- If a channel page succeeds but its Videos tab is unavailable, the Actor saves and charges the channel metadata row without fabricating video rows.
- Video likes, comments, tags, descriptions, and categories are currently emitted as nullable compatibility fields, not guaranteed analytics.
- The Actor reads public pages only and does not access YouTube Studio, private analytics, account data, or private videos.

## API example

```bash
curl -X POST "https://api.apify.com/v2/acts/fascinating_lentil~youtube-channel-scraper/runs?token=YOUR_APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channelUrls": ["https://www.youtube.com/@mkbhd"],
    "searchKeywords": [],
    "maxChannels": 1,
    "maxVideosPerChannel": 1,
    "includeShorts": false,
    "proxyConfiguration": {"useApifyProxy": false}
  }'
```

## Responsible use

Use this Actor only for lawful collection of publicly available information. You are responsible for complying with YouTube's terms, copyright rules, privacy laws, and regulations that apply to your use case.

Do not use the output for spam, harassment, profiling, or unlawful collection of personal data. This Actor is an independent tool and is not affiliated with, endorsed by, or sponsored by YouTube or Google.

## License

Apache-2.0.
