const express = require('express');
const cors = require('cors'); // Import CORS
const fetch = require('node-fetch'); // Using node-fetch

const app = express();
const port = process.env.PORT || 3001;

// Use CORS middleware
app.use(cors()); // Allows all origins by default. For production, you might want to restrict this.

app.get('/', (req, res) => {
  res.send('Vidzly Backend is Alive and Kicking!');
});

// New Reddit API proxy endpoint
app.get('/api/reddit/:subredditName', async (req, res) => {
  const { subredditName } = req.params;
  // Default limit to FEED_VIDEO_FETCH_LIMIT (25) if not provided or invalid
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit <= 0) {
    limit = 25; // Default value from your frontend constants
  }
  const { after = '' } = req.query;

  if (!subredditName) {
    return res.status(400).json({ error: 'Subreddit name is required.' });
  }

  // Fetch from /top.json?t=all for top posts of all time
  let redditApiUrl = `https://www.reddit.com/r/${encodeURIComponent(subredditName)}/top.json?t=all&limit=${limit}&raw_json=1`;
  if (after) {
    redditApiUrl += `&after=${encodeURIComponent(after)}`;
  }

  console.log(`[Vidzly Backend] Proxying request to: ${redditApiUrl}`); // For logging on Render

  try {
    const redditResponse = await fetch(redditApiUrl, {
        headers: {
            // It's good practice to set a User-Agent. Some APIs (including Reddit's) require it
            // or might block generic user agents.
            'User-Agent': 'VidzlyApp/1.0 (by /u/yourRedditUsername)' // Replace with your app's info or your Reddit username
        }
    });

    const responseStatus = redditResponse.status;
    const responseText = await redditResponse.text(); // Get text first to avoid issues if not JSON

    if (!redditResponse.ok) {
      console.error(`[Vidzly Backend] Reddit API error: ${responseStatus} for ${redditApiUrl}. Response: ${responseText}`);
      let errorJson;
      try {
        errorJson = JSON.parse(responseText);
      } catch (e) {
        // Not a JSON error response from Reddit
      }
      return res.status(responseStatus).json({ 
        error: errorJson ? (errorJson.message || 'Reddit API Error') : `Error fetching from Reddit: ${responseStatus}`, 
        details: `Failed to fetch data from r/${subredditName}. Reddit API returned status ${responseStatus}.`
      });
    }

    // If response is OK, parse it as JSON
    const redditData = JSON.parse(responseText);
    res.json(redditData);

  } catch (error) {
    console.error(`[Vidzly Backend] Error proxying Reddit API request for r/${subredditName}:`, error);
    res.status(500).json({ 
        error: 'Failed to fetch data from Reddit via proxy.',
        details: error.message 
    });
  }
});


app.listen(port, () => {
  console.log(`Vidzly backend listening on http://localhost:${port}`);
});