// server.js
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient: createOAuthClient } = require('simple-oauth2');
const { createClient: createKVClient } = require('@vercel/kv'); // For general KV caching
const { Redis } = require('@upstash/redis'); // For session store
const { UpstashRedisStore } = require('@upstash/connect'); // Session store connector

const app = express();

// --- Environment Variable Checks ---
const requiredEnvVars = [
  'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_REDIRECT_URI',
  'SESSION_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'
];
let missingEnvVar = false;
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`FATAL ERROR: Environment variable ${varName} is not set.`);
    missingEnvVar = true;
  }
});

if (missingEnvVar && process.env.NODE_ENV === 'production') {
  // In a real scenario, you might want to prevent the app from starting or throw an error.
  // For Vercel, it will likely fail to initialize properly.
  console.error("One or more required environment variables are missing. Application might not work correctly.");
}

// --- General KV Client (for Reddit API response caching) ---
let kvCacheClient;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  kvCacheClient = createKVClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  console.log("Vercel KV client (for API caching) initialized.");
} else {
  console.warn("Vercel KV env vars for API caching not found. Public API Caching will be disabled.");
}
const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

// --- Session Store with Upstash Redis (Vercel KV) ---
let sessionStore;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    // Upstash Redis client needs the full URL including credentials if present
    // Vercel KV provides KV_REST_API_URL and KV_REST_API_TOKEN separately.
    // The @upstash/redis client can be initialized like this with separate URL and token for HTTP.
    const redisForSessions = new Redis({
        url: process.env.KV_REST_API_URL, // Base URL for Upstash instance
        token: process.env.KV_REST_API_TOKEN, // Token for Upstash instance
    });
    sessionStore = new UpstashRedisStore({ client: redisForSessions, ttl: 86400 /* 1 day in seconds */ });
    console.log("UpstashRedisStore for sessions initialized.");
} else {
    console.warn("KV_REST_API_URL or KV_REST_API_TOKEN for session store not found. Sessions may not persist correctly.");
    // Fallback to MemoryStore for local dev if KV isn't set, but NOT recommended for Vercel.
}

// --- CORS Configuration ---
app.use(cors({
  origin: function (requestOrigin, callback) {
    // Allow all origins for now for simplicity. In production, restrict this.
    // For development with localhost frontend and deployed backend, this is okay.
    console.log("CORS check. Origin:", requestOrigin); // Log origin
    callback(null, true);
  },
  credentials: true // IMPORTANT for sending/receiving session cookies
}));

app.use(express.json()); // Middleware to parse JSON bodies

// --- Session Middleware ---
app.use(session({
  store: sessionStore, // Use Upstash Redis store if available
  secret: process.env.SESSION_SECRET || 'default_fallback_secret_vidzly_app_!@#', // Fallback for local dev only
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true in production (HTTPS)
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // 'none' for cross-site OAuth, requires secure: true
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));

// Ensure 'trust proxy' if Vercel (or any proxy) is in front for secure cookies
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// --- Reddit OAuth2 Configuration ---
const redditOAuthConfig = {
  client: {
    id: process.env.REDDIT_CLIENT_ID,
    secret: process.env.REDDIT_CLIENT_SECRET
  },
  auth: {
    tokenHost: 'https://www.reddit.com',
    tokenPath: '/api/v1/access_token',
    authorizePath: '/api/v1/authorize'
  },
  options: {
    authorizationMethod: 'body', // Reddit expects client_id & client_secret in the body for token exchange
  }
};
const oauth2 = createOAuthClient(redditOAuthConfig);

const REDDIT_USER_AGENT_PUBLIC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.159 Safari/537.36';
const REDDIT_USER_AGENT_OAUTH_PREFIX = 'web:vidzly-oauth:v1.0.0 (by /u/peterson7906)'; // Update with your app info

// --- Authentication Routes ---
app.get('/api/auth/reddit', (req, res) => {
  const state = require('crypto').randomBytes(20).toString('hex');
  req.session.oauth_state = state;
  const authorizationUri = oauth2.authorizationCode.authorizeURL({
    redirect_uri: process.env.REDDIT_REDIRECT_URI,
    scope: 'identity read mysubreddits history vote save submit privatemessages', // Adjust scopes as needed
    state: state,
    duration: 'permanent' // Or 'temporary'
  });
  res.redirect(authorizationUri);
});

app.get('/api/auth/reddit/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('OAuth Error:', error);
    return res.status(400).send(`OAuth Error: ${error}. <script>window.close();</script>`);
  }
  if (state !== req.session.oauth_state) {
    console.error('OAuth State Mismatch. Possible CSRF attack.');
    return res.status(403).send('Invalid state parameter. <script>window.close();</script>');
  }
  delete req.session.oauth_state; // Clean up state

  const tokenParams = {
    code: code,
    redirect_uri: process.env.REDDIT_REDIRECT_URI,
    scope: 'identity read mysubreddits history vote save submit privatemessages', // Must match authorizeURL
  };

  try {
    const accessToken = await oauth2.authorizationCode.getToken(tokenParams, {
        headers: { 'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} TokenExchange` }
    });
    req.session.reddit_token = accessToken; // Stores the whole token object (access_token, refresh_token, expires_at, etc.)
    console.log('OAuth token received and stored in session:', accessToken.token.access_token.substring(0,10) + "...");
    res.send('<script>window.opener.postMessage("reddit_auth_success", "*"); window.close();</script>');
  } catch (error) {
    console.error('Access Token Error:', error.message, error.context ? error.context.error_description : '');
    res.status(500).send(`Failed to get access token: ${error.message}. <script>window.close();</script>`);
  }
});

app.get('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).json({ message: 'Could not log out, please try again.' });
    }
    res.clearCookie('connect.sid'); // Default session cookie name
    console.log("Session destroyed, user logged out.");
    return res.status(200).json({ message: 'Logged out successfully' });
  });
});

// --- User Info Route (requires auth) ---
app.get('/api/reddit/me', async (req, res) => {
  if (!req.session || !req.session.reddit_token) {
    console.log("/api/reddit/me: No session or token found.");
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let accessToken = oauth2.accessToken.create(req.session.reddit_token);

  // Check if token is expired or close to expiring
  if (accessToken.expired(60)) { // Refresh if expires in next 60 seconds
    try {
      console.log("Token expired or expiring soon, attempting refresh...");
      accessToken = await accessToken.refresh({
          headers: { 'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} TokenRefresh` }
      });
      req.session.reddit_token = accessToken.token; // Save the new token
      console.log('Token refreshed successfully:', accessToken.token.access_token.substring(0,10) + "...");
    } catch (error) {
      console.error('Error refreshing token:', error.message);
      req.session.destroy(); // Destroy session if refresh fails
      return res.status(401).json({ error: 'Session expired, token refresh failed. Please log in again.' });
    }
  }

  try {
    const userResponse = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers: {
        'Authorization': `Bearer ${accessToken.token.access_token}`,
        'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} APIRequest /api/v1/me`
      }
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      console.error(`Error fetching /api/v1/me: ${userResponse.status}`, errorText.substring(0, 300));
      return res.status(userResponse.status).json({ error: 'Failed to fetch user data from Reddit', details: errorText.substring(0, 300) });
    }
    const userData = await userResponse.json();
    // Send only necessary fields to the client
    const clientUserData = {
      id: userData.id,
      name: userData.name,
      icon_img: userData.icon_img ? userData.icon_img.split('?')[0] : null // Get base URL for avatar
    };
    console.log("/api/reddit/me: User data fetched successfully for", clientUserData.name);
    return res.json(clientUserData);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return res.status(500).json({ error: 'Server error while fetching user profile' });
  }
});

// --- Reddit Proxy Route (handles both authenticated and unauthenticated) ---
app.get('/api/redditProxy/:subredditName', async (req, res) => {
  const { subredditName } = req.params;
  const { limit = 25, after = '' } = req.query;

  let fetchUrl;
  const headers = {};
  let useServerCache = true; // Only use server cache for public, unauthenticated requests

  if (req.session && req.session.reddit_token) {
    let accessToken = oauth2.accessToken.create(req.session.reddit_token);
    if (accessToken.expired(60)) {
      try {
        accessToken = await accessToken.refresh({ headers: { 'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} TokenRefresh` } });
        req.session.reddit_token = accessToken.token;
      } catch (refreshError) {
        console.error('Token refresh failed during proxy request, falling back to public.', refreshError.message);
        // Fall through to unauthenticated request if refresh fails
      }
    }
    // If still valid (or refreshed successfully)
    if (req.session.reddit_token && !accessToken.expired()) {
        fetchUrl = `https://oauth.reddit.com/r/${subredditName}/top.json?raw_json=1&t=all&limit=${limit}${after ? `&after=${after}` : ''}`;
        headers['Authorization'] = `Bearer ${accessToken.token.access_token}`;
        headers['User-Agent'] = `${REDDIT_USER_AGENT_OAUTH_PREFIX} APIRequest /r/${subredditName}`;
        useServerCache = false; // Do not use server-side general cache for authenticated requests
        console.log(`PROXY: Authenticated fetch for r/${subredditName} by ${req.session.reddit_token.token.access_token.substring(0,5)}...`);
    }
  }

  if (!fetchUrl) { // If not authenticated or token refresh failed
    fetchUrl = `https://www.reddit.com/r/${subredditName}/top.json?raw_json=1&t=all&limit=${limit}${after ? `&after=${after}` : ''}`;
    headers['User-Agent'] = REDDIT_USER_AGENT_PUBLIC;
    console.log(`PROXY: Unauthenticated public fetch for r/${subredditName}`);
  }

  const cacheKey = `reddit:${subredditName}:limit${limit}:after${String(after)}`;
  if (useServerCache && kvCacheClient) {
    try {
      const cachedData = await kvCacheClient.get(cacheKey);
      if (cachedData) {
        console.log(`CACHE: HIT (public) for ${cacheKey}`);
        return res.json(cachedData);
      }
      console.log(`CACHE: MISS (public) for ${cacheKey}`);
    } catch (kvError) {
      console.error(`KV_CACHE_ERROR: Failed to get from cache for ${cacheKey}:`, kvError);
    }
  }

  console.log(`PROXY: Fetching URL: ${fetchUrl}`);
  try {
    const redditResponse = await fetch(fetchUrl, { headers });
    if (!redditResponse.ok) {
      const errorText = await redditResponse.text();
      console.error(`PROXY_ERROR: Reddit API error for ${subredditName} (${redditResponse.status}) from URL ${fetchUrl}:`, errorText.substring(0, 500));
      return res.status(redditResponse.status).json({
        error: `Failed to fetch from Reddit: ${redditResponse.status}`,
        details: errorText.substring(0, 1000)
      });
    }
    const redditData = await redditResponse.json();

    if (useServerCache && kvCacheClient && redditData && Object.keys(redditData).length > 0) {
      try {
        await kvCacheClient.set(cacheKey, redditData, { ex: CACHE_TTL_SECONDS });
        console.log(`CACHE: SET (public) for ${cacheKey} with TTL ${CACHE_TTL_SECONDS}s`);
      } catch (kvError) {
        console.error(`KV_CACHE_ERROR: Failed to set cache for ${cacheKey}:`, kvError);
      }
    }
    return res.json(redditData);
  } catch (error) {
    console.error(`PROXY_CATCH_ERROR: Error proxying request for ${subredditName} to ${fetchUrl}:`, error);
    return res.status(500).json({
        error: 'Failed to proxy request to Reddit',
        details: error.message
    });
  }
});

// Health check and base API route
app.get('/api', (req, res) => {
  res.json({ message: 'Vidzly Backend with OAuth and Vercel KV Caching is active.' });
});
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Fallback for /api/* not found
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

const port = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Vidzly backend listening on http://localhost:${port}`);
  });
}
console.log(`Backend server.js loaded. Current NODE_ENV: ${process.env.NODE_ENV || 'development (default)'}`);
console.log(`Vercel env (prod build): ${process.env.VERCEL_ENV}`);

module.exports = app; // Required for Vercel