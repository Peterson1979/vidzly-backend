
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3';

if (!YOUTUBE_API_KEY) {
  console.error("FATAL ERROR: YOUTUBE_API_KEY environment variable is not set.");
  // In a real scenario, you might want to exit or prevent the server from starting fully.
}

app.use(cors({
  origin: (requestOrigin, callback) => {
    // For development, allow your frontend origin. For production, restrict.
    // Example: const allowedOrigins = ['http://localhost:YOUR_FRONTEND_PORT', 'https://your-frontend-domain.com'];
    // if (allowedOrigins.includes(requestOrigin) || !requestOrigin) {
    //   callback(null, true);
    // } else {
    //   callback(new Error('Not allowed by CORS'));
    // }
    callback(null, true); // Allow all for now, adjust for production
  },
  credentials: false // No cookies needed for this simple proxy
}));
app.use(express.json());

// Endpoint to get trending videos
app.get('/api/youtube/trending', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube API key not configured on server.' });

  const { regionCode = 'US', pageToken = '', maxResults = 10 } = req.query;
  try {
    const response = await axios.get(`${YOUTUBE_API_BASE_URL}/videos`, {
      params: {
        part: 'snippet,contentDetails,statistics',
        chart: 'mostPopular',
        regionCode: regionCode,
        maxResults: maxResults,
        pageToken: pageToken,
        key: YOUTUBE_API_KEY,
      },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching trending YouTube videos:', error.response ? error.response.data : error.message);
    res.status(error.response?.status || 500).json({ 
        error: 'Failed to fetch trending videos from YouTube.',
        details: error.response?.data?.error?.message 
    });
  }
});

// Endpoint to search videos (for categories)
app.get('/api/youtube/search', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube API key not configured on server.' });
  
  const { query, pageToken = '', maxResults = 10, channelId = '', order = 'relevance' } = req.query;

  if (!query && !channelId) {
    return res.status(400).json({ error: 'Search query or channelId is required.' });
  }

  try {
    const params = {
      part: 'snippet',
      q: query || undefined, // YouTube API expects 'q' for search queries
      channelId: channelId || undefined,
      type: 'video',
      maxResults: maxResults,
      pageToken: pageToken,
      key: YOUTUBE_API_KEY,
      order: order, // e.g., 'date', 'rating', 'relevance', 'title', 'viewCount'
    };

    const response = await axios.get(`${YOUTUBE_API_BASE_URL}/search`, { params });
    
    // The search endpoint returns items with videoId in item.id.videoId.
    // We need to make another call to get contentDetails (duration) and statistics (viewCount) for each video.
    const searchItems = response.data.items;
    if (!searchItems || searchItems.length === 0) {
      return res.json({ items: [], nextPageToken: response.data.nextPageToken });
    }

    const videoIds = searchItems.map((item: any) => item.id.videoId).join(',');
    
    const detailsResponse = await axios.get(`${YOUTUBE_API_BASE_URL}/videos`, {
      params: {
        part: 'snippet,contentDetails,statistics',
        id: videoIds,
        key: YOUTUBE_API_KEY,
      },
    });

    // Combine search snippets with video details
    const combinedItems = detailsResponse.data.items.map((detailItem: any) => {
        const searchItem = searchItems.find((sItem:any) => sItem.id.videoId === detailItem.id);
        return {
            ...detailItem, // This has snippet, contentDetails, statistics
            // snippet from detailItem is usually richer than from searchItem if there's overlap
        };
    });


    res.json({ 
      items: combinedItems, 
      nextPageToken: response.data.nextPageToken,
      prevPageToken: response.data.prevPageToken 
    });

  } catch (error) {
    console.error('Error searching YouTube videos:', error.response ? error.response.data : error.message);
     res.status(error.response?.status || 500).json({ 
        error: 'Failed to search videos on YouTube.',
        details: error.response?.data?.error?.message 
    });
  }
});


app.get('/api', (req, res) => res.json({ message: 'Vidzly YouTube Backend Active. Hello there!' }));
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Fallback for any other /api/* endpoint not found
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

const port = process.env.PORT || 3001;

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) { 
  app.listen(port, () => console.log(`Local backend server running on http://localhost:${port}`));
}

module.exports = app;
