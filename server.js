
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Using node-fetch v2 for CommonJS compatibility

const app = express();

// Simplified CORS configuration: Allows all origins for non-credentialed requests.
// This is generally okay for a public proxy, but for production, you might
// want to restrict it to your specific frontend's Vercel domain.
app.use(cors());

app.use(express.json()); // Middleware to parse JSON bodies

const port = process.env.PORT || 3001;
const REDDIT_USER_AGENT = 'VidzlyPublicClient/1.0 (by /u/peterson7906)'; // Remember to update with your Reddit username if you haven't

// --- Standard Endpoints ---
app.get('/api', (req, res) => {
  res.json({ message: 'Hello from the Vidzly Backend! Public API only.' });
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// --- Simplified Reddit Proxy Endpoint (Public Only) ---
app.get('/api/redditProxy/:subredditName', async (req, res) => {
  const { subredditName } = req.params;
  const { limit = 25, after } = req.query; // Default limit to 25 if not provided

  const headers = { 'User-Agent': REDDIT_USER_AGENT };
  // Constructing the URL for Reddit's JSON API for a subreddit's top posts
  let redditUrlBase = `https://www.reddit.com/r/${subredditName}/top.json?raw_json=1&t=all`; // t=all for all time top posts

  let fullRedditUrl = `${redditUrlBase}&limit=${limit}`;
  if (after) {
    fullRedditUrl += `&after=${after}`;
  }

  console.log(`PROXY: Public fetch for r/${subredditName}. URL: ${fullRedditUrl}`);

  try {
    const redditResponse = await fetch(fullRedditUrl, { headers });
    if (!redditResponse.ok) {
      const errorText = await redditResponse.text();
      console.error(`PROXY: Reddit API error for ${subredditName} (${redditResponse.status}) from URL ${fullRedditUrl}:`, errorText.substring(0, 500));
      // Send a JSON error response
      return res.status(redditResponse.status).json({ 
        error: `Failed to fetch from Reddit: ${redditResponse.status}`, 
        details: errorText.substring(0, 1000) // Limit error detail length
      });
    }
    const redditData = await redditResponse.json();
    return res.json(redditData);
  } catch (error) {
    console.error(`PROXY: Catch block error proxying request for ${subredditName} to ${fullRedditUrl}:`, error);
    // Send a JSON error response for caught exceptions
    return res.status(500).json({ 
        error: 'Failed to proxy request to Reddit', 
        details: error.message 
    });
  }
});

// Catch-all for undefined API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.listen(port, () => {
  console.log(`Vidzly backend (public only) listening on http://localhost:${port}`);
  console.log(`Current NODE_ENV: ${process.env.NODE_ENV || 'development (default)'}`);
});
