// server.js
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient: createOAuthClient } = require('simple-oauth2');
const { createClient: createKVClient } = require('@vercel/kv');
const { Redis } = require('@upstash/redis');
const { UpstashRedisStore } = require('@upstash/connect');

const app = express();

const requiredEnvVars = [
  'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_REDIRECT_URI',
  'SESSION_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'
];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) console.error(`FATAL ERROR: Env var ${varName} missing.`);
});

let kvCacheClient;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  kvCacheClient = createKVClient({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  console.log("Vercel KV client (API caching) initialized.");
} else {
  console.warn("KV env vars for API caching not found. Caching disabled.");
}
const CACHE_TTL_SECONDS = 300;

let sessionStoreInstance;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const redisForSessions = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    sessionStoreInstance = new UpstashRedisStore({ client: redisForSessions, ttl: 86400 });
    console.log("UpstashRedisStore for sessions initialized.");
} else {
    console.warn("KV env vars for session store not found. Sessions may not persist in production.");
}

app.use(cors({
  origin: (requestOrigin, callback) => callback(null, true), // Allow all for now
  credentials: true
}));
app.use(express.json());
app.use(session({
  store: sessionStoreInstance,
  secret: process.env.SESSION_SECRET || 'local_dev_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', maxAge: 86400000
  }
}));
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const redditOAuthConfig = {
  client: { id: process.env.REDDIT_CLIENT_ID, secret: process.env.REDDIT_CLIENT_SECRET },
  auth: { tokenHost: 'https://www.reddit.com', tokenPath: '/api/v1/access_token', authorizePath: '/api/v1/authorize' },
  options: { authorizationMethod: 'body' }
};
const oauth2 = createOAuthClient(redditOAuthConfig);
const REDDIT_USER_AGENT_PUBLIC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36';
const REDDIT_USER_AGENT_OAUTH_PREFIX = 'web:vidzly-oauth:v1.0.2 (by /u/peterson7906)';

app.get('/api/auth/reddit', (req, res) => {
  const state = require('crypto').randomBytes(16).toString('hex');
  req.session.oauth_state = state;
  req.session.save(err => {
    if (err) return res.status(500).send("Error saving session.");
    const authUri = oauth2.authorizationCode.authorizeURL({
        redirect_uri: process.env.REDDIT_REDIRECT_URI,
        scope: 'identity read mysubreddits history vote save submit privatemessages', state: state, duration: 'permanent'
    });
    res.redirect(authUri);
  });
});

app.get('/api/auth/reddit/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const respondToPopup = (message) => res.send(`<script>window.opener.postMessage("${message}", "*"); window.close();</script>`);
  if (oauthError) return respondToPopup("reddit_auth_failure");
  if (!req.session || state !== req.session.oauth_state) return respondToPopup("reddit_auth_failure");
  delete req.session.oauth_state;
  try {
    const tokenData = { code: code, redirect_uri: process.env.REDDIT_REDIRECT_URI, scope: 'identity read mysubreddits history vote save submit privatemessages' };
    const accessToken = await oauth2.authorizationCode.getToken(tokenData, { headers: { 'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} TokenExchange` } });
    req.session.reddit_token = accessToken.token;
    req.session.save(err => {
        if(err) return respondToPopup("reddit_auth_failure");
        respondToPopup("reddit_auth_success");
    });
  } catch (error) {
    console.error('Access Token Error:', error.message);
    respondToPopup("reddit_auth_failure");
  }
});

app.get('/api/auth/logout', (req, res) => {
  if (req.session) req.session.destroy(err => {
    if (err) return res.status(500).json({ message: 'Logout error.' });
    res.clearCookie('connect.sid'); return res.status(200).json({ message: 'Logged out.' });
  }); else return res.status(200).json({ message: 'No session.' });
});

app.get('/api/reddit/me', async (req, res) => {
  if (!req.session || !req.session.reddit_token) return res.status(401).json({ error: 'Not authenticated' });
  let accessToken = oauth2.accessToken.create(req.session.reddit_token);
  if (accessToken.expired(60)) {
    try {
      accessToken = await accessToken.refresh({}, { headers: { 'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} TokenRefresh` } });
      req.session.reddit_token = accessToken.token;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve(null)));
    } catch (error) { req.session.destroy(); return res.status(401).json({ error: 'Session expired, refresh failed.' }); }
  }
  try {
    const userRes = await fetch('https://oauth.reddit.com/api/v1/me', { headers: { 'Authorization': `Bearer ${accessToken.token.access_token}`, 'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} APIRequest /me` }});
    if (!userRes.ok) throw new Error(`Reddit API error /me: ${userRes.status}`);
    const uData = await userRes.json();
    return res.json({ id: uData.id, name: uData.name, icon_img: uData.icon_img ? uData.icon_img.split('?')[0] : null });
  } catch (error) { return res.status(500).json({ error: 'Server error fetching user.' }); }
});

app.get('/api/redditProxy/:subredditName', async (req, res) => {
  const { subredditName } = req.params; const { limit = 25, after = '' } = req.query;
  let fetchUrl, headers = {}, useServerCache = true;
  if (req.session && req.session.reddit_token) {
    let tokenInst = oauth2.accessToken.create(req.session.reddit_token);
    if (tokenInst.expired(60)) {
        try {
            tokenInst = await tokenInst.refresh({ headers: { 'User-Agent': `${REDDIT_USER_AGENT_OAUTH_PREFIX} TokenRefresh` } });
            req.session.reddit_token = tokenInst.token;
            await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve(null)));
        } catch (e) { delete req.session.reddit_token; await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve(null))); }
    }
    if (req.session && req.session.reddit_token) {
        const currentToken = oauth2.accessToken.create(req.session.reddit_token);
        fetchUrl = `https://oauth.reddit.com/r/${subredditName}/top.json?raw_json=1&t=all&limit=${limit}${after ? `&after=${after}` : ''}`;
        headers['Authorization'] = `Bearer ${currentToken.token.access_token}`;
        headers['User-Agent'] = `${REDDIT_USER_AGENT_OAUTH_PREFIX} APIRequest /r/${subredditName}`;
        useServerCache = false;
    }
  }
  if (!fetchUrl) {
    fetchUrl = `https://www.reddit.com/r/${subredditName}/top.json?raw_json=1&t=all&limit=${limit}${after ? `&after=${after}` : ''}`;
    headers['User-Agent'] = REDDIT_USER_AGENT_PUBLIC;
  }
  const cacheKey = `pub_reddit:${subredditName}:l${limit}:a${String(after)}`;
  if (useServerCache && kvCacheClient) {
    try { const cachedData = await kvCacheClient.get(cacheKey); if (cachedData) return res.json(cachedData); }
    catch (e) { console.error(`KV GET ${cacheKey}:`, e); }
  }
  try {
    const rResponse = await fetch(fetchUrl, { headers });
    if (!rResponse.ok) { const eTxt = await rResponse.text(); return res.status(rResponse.status).json({ error: `Reddit error: ${rResponse.status}`, details: eTxt.substring(0,500) });}
    const rData = await rResponse.json();
    if (useServerCache && kvCacheClient && rData && Object.keys(rData).length > 0) {
      try { await kvCacheClient.set(cacheKey, rData, { ex: CACHE_TTL_SECONDS }); }
      catch (e) { console.error(`KV SET ${cacheKey}:`, e); }
    }
    return res.json(rData);
  } catch (e) { return res.status(500).json({ error: 'Proxy failed', details: e.message }); }
});

app.get('/api', (req, res) => res.json({ message: 'Vidzly Backend Active.' }));
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
const port = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) { app.listen(port, () => console.log(`Local backend on http://localhost:${port}`));}
module.exports = app; // Essential for Vercel
Use code with caution.
JavaScript
3. File: D:\Oldal\Tartalom\Offers links\Lifesoffers\APPOK\VIDZLY\Vidzly app\vidzly-backend\vercel.json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    }
  ],
  "rewrites": [
    {
      "source": "/api/(.*)",
      "destination": "/server.js"
    }
  ]
}