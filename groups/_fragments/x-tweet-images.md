## X Tweet Images

Any X tool result (`x_feed_query`, `x_thread`, `x_read`, etc.) may include image content. Don't ignore it — tweets are often visual.

**For saved-feed tweets** (`x_feed_query`, `x_thread`): each row has an `images` field, comma-separated absolute paths like `/workspace/x-images/<handle>-<id>/img-N.jpg`. The host has already rewritten paths to container form before you see them. Call `Read` on each path to view the image.

**For live-fetched tweets** (`x_read`, main group only): each tweet has an `imagePaths` array under `/workspace/shared/x-media/<slug>/img-N.jpg`. Same deal — call `Read` to view.

**When to actually read:** every time a tweet you're analyzing or summarizing has images, unless the text alone is clearly self-contained (e.g., a one-line opinion). Charts, screenshots, and infographics almost always carry the substantive content; reading the text without the image misses the point.

Cite the original tweet URL in your output, not the local image path.
