
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Using node-fetch v2 for CommonJS compatibility
const { createClient } = require('@vercel/kv');

const app = express();

// Vercel KV client
// Vercel automatically provides KV_URL, KV_REST_API_URL, KV_REST_API_TOKEN, etc.
// when a KV store is connected to the project.
let kvClient;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  kvClient = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  console.log("Vercel KV client initialized.");
} else {
  console.warn("Vercel KV environment variables not found. KV Caching will be disabled.");
}

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes Time-To-Live for cache

app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3001;
const REDDIT_USER_AGENT = 'VidzlyPublicClient/1.0 (by /u/peterson7906)';

app.get('/api', (req, res) => {
  res.json({ message: 'Hello from the Vidzly Backend! Public API only with Vercel KV Caching.' });
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/redditProxy/:subredditName', async (req, res) => {
  const { subredditName } = req.params;
  const { limit = 25, after = '' } = req.query; // Default after to empty string for consistent cache key

  const cacheKey = `reddit:${subredditName}:limit${limit}:after${after}`;

  if (kvClient) {
    try {
      const cachedData = await kvClient.get(cacheKey);
      if (cachedData) {
        console.log(`CACHE: HIT for ${cacheKey}`);
        return res.json(cachedData);
      }
      console.log(`CACHE: MISS for ${cacheKey}`);
    } catch (kvError) {
      console.error(`KV_ERROR: Failed to get from cache for ${cacheKey}:`, kvError);
      // Proceed to fetch from Reddit if cache read fails
    }
  }

  const headers = { 'User-Agent': REDDIT_USER_AGENT };
  let redditUrlBase = `https://www.reddit.com/r/${subredditName}/top.json?raw_json=1&t=all`;
  let fullRedditUrl = `${redditUrlBase}&limit=${limit}`;
  if (after) { // Only add 'after' if it's not an empty string
    fullRedditUrl += `&after=${after}`;
  }

  console.log(`PROXY: Public fetch for r/${subredditName}. URL: ${fullRedditUrl}`);

  try {
    const redditResponse = await fetch(fullRedditUrl, { headers });
    if (!redditResponse.ok) {
      const errorText = await redditResponse.text();
      console.error(`PROXY_ERROR: Reddit API error for ${subredditName} (${redditResponse.status}) from URL ${fullRedditUrl}:`, errorText.substring(0, 500));
      return res.status(redditResponse.status).json({
        error: `Failed to fetch from Reddit: ${redditResponse.status}`,
        details: errorText.substring(0, 1000)
      });
    }
    const redditData = await redditResponse.json();

    if (kvClient && redditData) {
      try {
        // Store in cache with TTL
        await kvClient.set(cacheKey, redditData, { ex: CACHE_TTL_SECONDS });
        console.log(`CACHE: SET for ${cacheKey} with TTL ${CACHE_TTL_SECONDS}s`);
      } catch (kvError) {
        console.error(`KV_ERROR: Failed to set cache for ${cacheKey}:`, kvError);
      }
    }
    return res.json(redditData);
  } catch (error) {
    console.error(`PROXY_CATCH_ERROR: Error proxying request for ${subredditName} to ${fullRedditUrl}:`, error);
    return res.status(500).json({
        error: 'Failed to proxy request to Reddit',
        details: error.message
    });
  }
});

app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.listen(port, () => {
  console.log(`Vidzly backend (with Vercel KV caching) listening on http://localhost:${port}`);
  console.log(`Current NODE_ENV: ${process.env.NODE_ENV || 'development (default)'}`);
});
