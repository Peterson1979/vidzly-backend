const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Use CommonJS require for node-fetch v2.x

const app = express();
const port = process.env.PORT || 3001;

// Use CORS middleware
app.use(cors()); // Allows all origins by default.

app.get('/', (req, res) => {
  console.log('[Vidzly Backend] Root route (/) accessed at: ' + new Date().toISOString());
  res.send('Vidzly Backend is Alive and Kicking!');
});

// Reddit API proxy endpoint
app.get('/api/reddit/:subredditName', async (req, res) => {
  const { subredditName } = req.params;
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit <= 0) {
    limit = 25;
  }
  const { after = '' } = req.query;

  if (!subredditName) {
    console.log('[Vidzly Backend] Subreddit name is required - sending 400.');
    return res.status(400).json({ error: 'Subreddit name is required.' });
  }

  let redditApiUrl = `https://www.reddit.com/r/${encodeURIComponent(subredditName)}/top.json?t=all&limit=${limit}&raw_json=1`;
  if (after) {
    redditApiUrl += `&after=${encodeURIComponent(after)}`;
  }

  console.log(`[Vidzly Backend] Proxying request to: ${redditApiUrl}`);

  try {
    const redditResponse = await fetch(redditApiUrl, {
        headers: {
            // More specific User-Agent for Reddit API
            'User-Agent': 'node:vidzly.proxy.app:v1.0 (by /u/peterson7906)'
        }
    });

    const responseStatus = redditResponse.status;
    // Get text first to avoid JSON parse errors on non-JSON responses (like HTML error pages from Reddit)
    const responseText = await redditResponse.text(); 

    if (!redditResponse.ok) {
      console.error(`[Vidzly Backend] Reddit API error: ${responseStatus} for ${redditApiUrl}. Response: ${responseText}`);
      let errorJsonMessage = `Error fetching from Reddit: ${responseStatus}`;
      try {
        const parsedError = JSON.parse(responseText);
        if (parsedError && parsedError.message) {
            errorJsonMessage = parsedError.message;
        }
      } catch (e) {
        // Response was not JSON, use the generic message
      }
      return res.status(responseStatus).json({ 
        error: errorJsonMessage, 
        details: `Failed to fetch data from r/${subredditName}. Reddit API returned status ${responseStatus}.`
      });
    }

    // If response is OK, parse it as JSON
    const redditData = JSON.parse(responseText);
    console.log(`[Vidzly Backend] Successfully fetched and parsed data from r/${subredditName}.`);
    res.json(redditData);

  } catch (error) {
    console.error(`[Vidzly Backend] CATCH BLOCK - Error proxying Reddit API request for r/${subredditName}:`, error.message, error.stack);
    res.status(500).json({ 
        error: 'Failed to fetch data from Reddit via proxy.',
        details: error.message 
    });
  }
});

app.listen(port, () => {
  console.log(`[Vidzly Backend] Server listening on http://localhost:${port} at: ` + new Date().toISOString());
});

process.on('uncaughtException', (error) => {
  console.error('[Vidzly Backend] FATAL: Uncaught Exception:', error.message, error.stack);
  process.exit(1); 
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Vidzly Backend] FATAL: Unhandled Rejection at:', promise, 'reason:', reason);
});