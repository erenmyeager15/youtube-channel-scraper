# YouTube Creator Research - US Agency Promotion Notes

Keep promotion grounded in the current public-page output. Do not imply access to YouTube Studio or private analytics.

## Positioning

Help US agencies and content strategists prepare a public creator shortlist or competitor publishing comparison. Collect channel stats, recent videos and Shorts from direct URLs, export CSV, and attach coverage evidence. The same public source is global: this does not identify US audiences or supply private YouTube Analytics.

Primary landing page: [YouTube Creator Research for US Agencies](https://apify.com/fascinating_lentil/youtube-channel-scraper/examples/us-youtube-creator-research).
The new two-channel starter is a saved, bounded Fast-mode configuration; no new live test or schedule is included. For the reporting workflow, use [the comparison checklist](examples/US-CREATOR-COMPARISON.md).

## YouTube title options

1. YouTube Creator Research for US Agencies: Public Stats to CSV
2. Compare YouTube Competitor Videos and Shorts with Apify
3. Build a Public Creator Shortlist without a YouTube API Key

## Short tutorial script

1. Open YouTube Channel Scraper on Apify.
2. Explain that US-first means a buyer workflow, not US audience data.
3. Paste one channel URL for a first small run, or use the two-channel research starter with up to five videos and three Shorts per channel.
4. Keep Fast mode and proxy off. Do not silently enable paid fallback when fields are missing.
5. Show the `Channels` view with name, subscribers, video count, and verification.
6. Show the `Videos` view with title, views, duration, publish text, and URL.
7. Export the full CSV/JSON dataset with `recordType`, `channelUrl` and `scrapedAt`. The Videos view omits `channelUrl`; views do not filter record types.
8. Inspect `RUN-SUMMARY`, separate formats and compare the bounded sample in your own reporting tool. Repeated snapshots require a separate run; the Actor has no built-in cross-run history or automatic comparison report.

## Social post

Building a creator shortlist or competitor content report for a US client?

YouTube Channel Scraper exports public subscribers, recent titles, view labels, durations and Shorts. Start with two example creators in Fast mode, inspect coverage, and compare the exported CSV in your own reporting workflow. Global channels are supported; no US audience demographics or private analytics are claimed.

No YouTube login or API key. Selected content is bundled into the channel charge. The starter is a configuration, not a newly verified dataset or automatic growth report. No external social post is sent by this package.

## SEO keywords

- youtube channel scraper
- youtube channel stats scraper
- scrape youtube channel data
- youtube latest videos scraper
- youtube channel analytics export
- export youtube channel data to csv
- youtube scraper apify
- youtube channel monitoring
- youtube creator research for agencies
- youtube competitor content research
- youtube shorts comparison csv

## Claim guardrails

- Say "public channel stats," not "full YouTube analytics."
- Do not claim access to YouTube Studio, audience demographics, revenue, or private data.
- Do not promise likes, comments, tags, descriptions, country, join date, or total views.
- Do not describe abbreviated public counts as exact live analytics.
- Mention that search results vary by region and ranking.
- State that the tool is independent and not affiliated with YouTube or Google.
- US-first means US buyers, not US-only channels or audience geography.
- Do not promise persistent growth history, automatic change detection, scored shortlists, or verified contacts.
- Explain that two successfully saved channels cost $0.00605 in current FREE-tier listed events at 256 MB, not that every run is guaranteed profitable.
