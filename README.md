# YouTube Channel Scraper — Extract Analytics & Video Data

A production-ready Apify Actor that scrapes YouTube for comprehensive channel and video analytics data.

## What it does

This Actor extracts detailed data from YouTube channels and their latest videos. Provide channel URLs, handles (e.g., `@mkbhd`), or search keywords — the Actor will scrape channel metadata and video analytics for each result.

### Channel Data Extracted
- Channel name, handle, and URL
- Subscriber count, total views, total video count
- Join date and country
- Channel description and avatar/banner images
- Verified badge status
- Social links and contact email
- Channel category/topic

### Video Data Extracted (per latest N videos)
- Video title and URL
- View count, like count, comment count
- Duration (seconds + formatted)
- Published date and thumbnail URL
- Video description (first 500 chars)
- Tags list and category
- YouTube Shorts detection

## Use Cases

1. **Influencer Research** — Analyze potential influencer partners by examining their subscriber growth, engagement rates, and content consistency across recent videos.

2. **Competitor Analysis** — Track competitor channels to understand their upload frequency, video performance, and content strategy over time.

3. **Content Strategy** — Study successful channels in your niche to identify trending topics, optimal video lengths, and high-performing content formats.

4. **Agency Reporting** — Automate the collection of client channel metrics for regular performance reports without manual data entry.

5. **Brand Partnership Research** — Evaluate potential brand partners by analyzing their audience size, engagement metrics, and content quality before outreach.

## Sample Output

### Channel Record

```json
{
  "channelUrl": "https://www.youtube.com/@mkbhd",
  "channelName": "Marques Brownlee",
  "handle": "@mkbhd",
  "subscriberCount": "19.3M subscribers",
  "subscriberCountNumber": 19300000,
  "totalViews": "4,613,201,035 views",
  "totalViewsNumber": 4613201035,
  "totalVideoCount": "1,823 videos",
  "totalVideoCountNumber": 1823,
  "joinDate": "Mar 22, 2008",
  "country": "United States",
  "channelDescription": "MKBHD uploads quality videos about technology...",
  "avatarImageUrl": "https://yt3.googleusercontent.com/...",
  "bannerImageUrl": "https://yt3.googleusercontent.com/...",
  "channelCategory": "Science & Technology",
  "isVerified": true,
  "socialLinks": ["https://twitter.com/MKBHD"],
  "contactEmail": null,
  "scrapedAt": "2026-06-08T12:00:00.000Z"
}
```

### Video Record

```json
{
  "channelUrl": "https://www.youtube.com/@mkbhd",
  "channelName": "Marques Brownlee",
  "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "videoTitle": "Galaxy S25 Ultra Review: The Best Samsung Phone?",
  "viewCount": "5,234,567 views",
  "viewCountNumber": 5234567,
  "likeCount": "182K likes",
  "likeCountNumber": 182000,
  "commentCount": "12,345 comments",
  "commentCountNumber": 12345,
  "durationSeconds": 1245,
  "durationFormatted": "20:45",
  "publishedDate": "Jan 22, 2026",
  "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "videoDescription": "The Samsung Galaxy S25 Ultra is here with a new chip...",
  "tags": ["samsung", "galaxy s25", "review", "android"],
  "category": "Science & Technology",
  "isShorts": false,
  "scrapedAt": "2026-06-08T12:00:00.000Z"
}
```

## Pricing

| Event | Price | Description |
|-------|-------|-------------|
| Channel Scraped | $0.005 | Per channel — includes full channel metadata + N latest videos |

**Example cost:** 10 channels × 20 videos each = $0.05 total

The per-channel pricing keeps costs simple and predictable. You pay once per channel regardless of how many videos are scraped.

## Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `channelUrls` | `string[]` | `[]` | YouTube channel URLs or @handles to scrape |
| `searchKeywords` | `string[]` | `[]` | Keywords to search for channels |
| `maxChannels` | `number` | `10` | Max channels per search keyword |
| `maxVideosPerChannel` | `number` | `20` | Videos to scrape per channel (max 100) |
| `includeShorts` | `boolean` | `false` | Include YouTube Shorts in results |
| `proxyConfiguration` | `object` | `{ useApifyProxy: true }` | Proxy settings |

## Known Limitations

- **Subscriber count hidden:** Some smaller or private channels hide subscriber counts. The Actor returns `null` for these fields.
- **YouTube rate limiting:** Very large runs (100+ channels) may experience temporary blocks. The Actor uses session pools and random delays to mitigate this.
- **Like counts:** YouTube sometimes displays abbreviated like counts (e.g., "123K"). The Actor stores both the raw text and parsed numeric value.
- **Shorts duration:** YouTube Shorts may not always report accurate duration data due to platform limitations.
- **Search mode:** Channel search results may vary by region and are subject to YouTube's search algorithm ranking.

## Resources

- [Apify Platform](https://apify.com)
- [Crawlee Documentation](https://crawlee.dev)
- [Playwright API](https://playwright.dev)
