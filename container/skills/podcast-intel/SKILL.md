---
name: podcast-intel
description: Download transcripts from YouTube videos or podcast pages and extract structured intelligence (costs, financials, predictions, company views, technical insights) into markdown files on the mounted filesystem. Use when the user shares a podcast or video URL and wants analysis.
allowed-tools: Bash(*), Write, Read, Edit, WebFetch, WebSearch
---

# Podcast Intelligence Extractor

Given a URL (YouTube video, podcast page, or any media page), this skill:
1. Downloads or scrapes the full transcript
2. Saves the raw transcript to `/workspace/ipc/transcripts/`
3. Extracts structured intelligence into a `.md` file in `/workspace/ipc/insights/`
4. Offers to update the master synthesis at `/workspace/ipc/insights/00_MASTER_SYNTHESIS.md`

## ARGUMENTS

The argument is a URL. Example:
```
/podcast-intel https://www.youtube.com/watch?v=XXXXX
/podcast-intel https://some-podcast-site.com/episode/xyz
```

## STEP 1 — DETECT SOURCE TYPE

Check if the URL is a YouTube URL (contains `youtube.com` or `youtu.be`):
- **YouTube** → use `youtube-transcript-api` (Python)
- **Non-YouTube** → use `agent-browser` to scrape the page

## STEP 2A — YOUTUBE TRANSCRIPT (if YouTube URL)

Extract the video ID from the URL, then run:

```bash
python3 -c "
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
video_id = 'VIDEO_ID_HERE'

# List available transcripts
tl = api.list(video_id)
for t in tl:
    print(t.language_code, t.is_generated)

# Prefer manual English, fallback to auto-generated
transcript = None
for t in tl:
    if t.language_code == 'en' and not t.is_generated:
        transcript = t.fetch()
        break
if not transcript:
    transcript = api.fetch(video_id)

print(f'Got {len(transcript)} entries')
"
```

If `youtube-transcript-api` is not installed:
```bash
pip3 install youtube-transcript-api --break-system-packages
```

To get the video title, use `agent-browser` to open the YouTube URL and read the page title.

Save the transcript to `/workspace/ipc/transcripts/<slug>.txt` with timestamped lines:
```
[MM:SS] text here
```

## STEP 2B — WEB/PODCAST TRANSCRIPT (if non-YouTube URL)

1. Open the page with `agent-browser open <url>`
2. Extract page text with `agent-browser eval "document.body.innerText"`
3. If the output is too large (>50KB), it will be saved to a temp file — read that file
4. Look for transcript content in the page text
5. If no transcript found on the page, search for the video on YouTube by title:
   - Get page title first: `agent-browser get title`
   - Search YouTube: `https://www.youtube.com/results?search_query=<title>`
   - Extract video IDs using: `agent-browser eval "Array.from(document.querySelectorAll('a#video-title')).map(a => a.href + ' | ' + a.title).join('\n')"`
   - Try `youtube-transcript-api` on matching YouTube video IDs

## STEP 3 — GENERATE CLEAN FILENAME

Create a slug from the video title:
- Lowercase, replace spaces with underscores
- Remove special characters
- Include the speaker name and year if identifiable
- Example: `dylan_patel_nvidia_supply_chain_2026.txt`

Save transcript to: `/workspace/ipc/transcripts/<slug>.txt`

## STEP 4 — EXTRACT INTELLIGENCE

Read the transcript file and extract ALL of the following into a structured markdown file. Be exhaustive — include every number, every prediction, every company mention.

### Categories to extract:

**1. Cost Metrics**
- Cost per GW to build data center (all-in CapEx)
- Annual rental cost per GW
- GPU TCO by generation (hourly cost)
- Memory costs (HBM, DRAM, NAND pricing)
- EUV tool costs
- Power costs
- Any other specific cost figures

**2. Capacity Plans (by company, by year)**
- GW of compute online now, end of year, next year, 2027, 2028
- Data center sizes (GPU counts, MW)
- CapEx spend by hyperscaler

**3. Investment & Deal Figures**
- Fundraises (amount, who raised)
- CapEx commitments (who, how much, when)
- Key deal structures (e.g. OpenAI-Nvidia-Oracle mechanics)
- Contract values and durations

**4. Margin Structure**
- Gross margin % at each layer of the stack
- Who captures what % of gross profit
- Revenue figures and growth rates

**5. Revenue & Growth**
- ARR figures with dates (label as point-in-time)
- Growth rates (monthly, annual)
- Token pricing trends

**6. Technical Constraints & Bottlenecks**
- What is the current primary bottleneck
- Timeline for each bottleneck to be hit/resolved
- Supply chain specifics (wafer counts, tool counts, lead times)

**7. Company-Specific Intelligence**
For each company mentioned: key claims, financial metrics, strategic position

**8. Geopolitics & China**
- China semiconductor capabilities (specific numbers)
- Export control effectiveness
- Taiwan risk scenarios

**9. Scaling Laws & AI Technical Trajectory**
- Where scaling is/isn't working
- RL/post-training status
- Architecture efficiency insights

**10. Predictions & Timelines**
- All specific year-based predictions
- Label: [YEAR] [PREDICTION] [SPEAKER'S CONFIDENCE if stated]

**11. Economic & Social Implications**
- Job displacement (specific sectors, numbers)
- AI value creation estimates
- Political risks

**12. Notable Quotes**
- Direct quotes that are especially pithy or informative (with timestamps)

## STEP 5 — SAVE INSIGHTS FILE

Determine the next available file number in `/workspace/ipc/insights/`:
```bash
ls /workspace/ipc/insights/ | grep -v "^00_" | sort | tail -1
```

Save to: `/workspace/ipc/insights/NN_<slug>.md`

Use this header template:
```markdown
# Intelligence Extract: <Video Title>
**Source:** <URL>
**Speaker(s):** <Names>
**Date:** <Publication date if known, otherwise extraction date>
**Extracted:** <Today's date>
**Transcript:** /workspace/ipc/transcripts/<slug>.txt

---
```

Then all 12 sections above.

## STEP 6 — OFFER MASTER SYNTHESIS UPDATE

After saving the insights file, tell the user:
- Where the transcript was saved
- Where the insights file was saved
- How many entries the transcript has / file size
- Ask: "Would you like me to update the master synthesis at `00_MASTER_SYNTHESIS.md` to include this new source?"

If yes, read `00_MASTER_SYNTHESIS.md` and the new insights file, then update the master synthesis by:
- Adding the new source to the header source list
- Merging/updating any figures that are newer or more precise
- Adding new data points not previously captured
- Flagging any conflicts with existing data

## ERROR HANDLING

- If `youtube-transcript-api` fails (e.g. transcript disabled): try `agent-browser` to scrape the YouTube page for any auto-captions
- If no transcript available anywhere: tell the user and suggest alternatives (manual paste, different URL)
- If the insights directory doesn't exist: `mkdir -p /workspace/ipc/insights /workspace/ipc/transcripts`

## EXAMPLE USAGE

User: `/podcast-intel https://www.youtube.com/watch?v=mDG_Hx3BSUE`

Expected output:
1. ✅ Transcript saved: `/workspace/ipc/transcripts/dylan_patel_ai_compute_bottleneck_dwarkesh_2026.txt` (1,706 entries)
2. ✅ Insights saved: `/workspace/ipc/insights/09_dylan_patel_ai_compute_bottleneck_dwarkesh_2026.md`
3. Ask about master synthesis update
