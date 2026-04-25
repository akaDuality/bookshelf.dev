// Centralized Stripe paywall and router for paid books on bookshelf.dev.
//
// Each request hits this Worker (via routes in wrangler.toml):
//   1. /auth/verify  (POST) and /auth/logout  - handled here
//   2. /<book-slug>/* - paywall check, then proxy to <slug>.pages.dev
//
// Free books (e.g. a11y-book) keep their own simple routers and bypass
// this Worker entirely.
//
// Note: the upstream <slug>.pages.dev URLs are publicly reachable. Anyone
// who learns the URL can read paid content directly. To close that hole,
// front the Pages project with Cloudflare Access (service-token policy)
// and add CF-Access-Client-Id / CF-Access-Client-Secret headers to the
// upstream fetch in proxyToBook.
//
// Required Worker secrets (set via `wrangler secret put` or dashboard):
//   STRIPE_SECRET_KEY     Stripe secret API key (sk_live_... / sk_test_...)
//   STRIPE_PAYMENT_LINK   Stripe Payment Link URL
//   SESSION_SECRET        Random string for HMAC-signing session cookies

const COOKIE_NAME = 'bookshelf_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

// Registry of paid books proxied by this Worker.
// To add a paid book: register its slug, .pages.dev host, and free-content
// rules here, and add the matching routes to wrangler.toml.
const BOOKS = {
  'testing-book': {
    pagesHost: 'testing-book.pages.dev',
    freeSections: ['0-', '1-'],
    freeArticles: [],
  },
};

// --- Crypto helpers ---

async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacVerify(data, hex, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const sigBytes = new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
  return crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(data));
}

async function createSession(userId, secret) {
  const payload = btoa(JSON.stringify({
    sub: userId,
    exp: Date.now() + SESSION_MAX_AGE * 1000,
  }));
  const sig = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

async function verifySession(cookie, secret) {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!await hmacVerify(payload, sig, secret)) return null;
  try {
    const data = JSON.parse(atob(payload));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Cookie is scoped to the entire bookshelf.dev domain so a single login
// covers all current and future paid books.
function setCookieHeader(value, maxAge) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// --- Stripe API ---

async function findCustomerByEmail(email, stripeKey) {
  const query = encodeURIComponent(`email:"${email}"`);
  const res = await fetch(`https://api.stripe.com/v1/customers/search?query=${query}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  const data = await res.json();
  return data.data?.[0] || null;
}

async function hasActiveAccess(customerId, stripeKey) {
  const subsRes = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=1`,
    { headers: { Authorization: `Bearer ${stripeKey}` } },
  );
  const subs = await subsRes.json();
  if (subs.data?.length > 0) return true;

  const chargesRes = await fetch(
    `https://api.stripe.com/v1/charges?customer=${customerId}&limit=100`,
    { headers: { Authorization: `Bearer ${stripeKey}` } },
  );
  const charges = await chargesRes.json();
  return charges.data?.some(c => c.paid && !c.refunded);
}

// --- Free path resolution ---

function isFreeArticleSlug(book, slug) {
  const lower = slug.toLowerCase();
  if (book.freeArticles.some(a => a.toLowerCase() === lower)) return true;
  return book.freeSections.some(prefix => lower.startsWith(prefix.toLowerCase()));
}

// `path` here is the upstream path (book-slug already stripped).
function isFreePath(book, path) {
  const lower = path.toLowerCase();

  if (!lower.startsWith('/documentation/') && !lower.startsWith('/data/documentation/') &&
      !lower.startsWith('/tutorials/') && !lower.startsWith('/data/tutorials/')) {
    return true;
  }

  if (lower === '/documentation/book' || lower === '/documentation/book/') return true;
  if (lower === '/data/documentation/book.json') return true;

  const htmlMatch = lower.match(/^\/documentation\/book\/([^/.]+)\/?$/);
  if (htmlMatch) return isFreeArticleSlug(book, htmlMatch[1]);

  const jsonMatch = lower.match(/^\/data\/documentation\/book\/([^/.]+)\.json$/);
  if (jsonMatch) return isFreeArticleSlug(book, jsonMatch[1]);

  return false;
}

// --- Login page ---

function loginPage(paymentLink, error, returnTo) {
  const errorHtml = error ? `<div class="error">${error}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bookshelf Access</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; background: #f5f5f7; color: #1d1d1f;
    }
    .card {
      width: 100%; max-width: 400px; padding: 48px 32px;
      background: white; border-radius: 16px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    .icon { font-size: 48px; text-align: center; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 600; text-align: center; margin-bottom: 8px; }
    .subtitle { font-size: 15px; color: #6e6e73; text-align: center; line-height: 1.4; margin-bottom: 28px; }
    label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 6px; color: #1d1d1f; }
    input[type="email"] {
      width: 100%; padding: 10px 14px; border: 1px solid #d2d2d7;
      border-radius: 8px; font-size: 16px; outline: none;
      transition: border-color 0.2s;
    }
    input[type="email"]:focus { border-color: #0071e3; }
    .btn {
      display: block; width: 100%; padding: 12px; border: none;
      border-radius: 980px; font-size: 16px; font-weight: 500;
      cursor: pointer; text-align: center; text-decoration: none;
      transition: background 0.2s;
    }
    .btn-primary { background: #0071e3; color: white; margin-top: 16px; }
    .btn-primary:hover { background: #0077ED; }
    .divider {
      text-align: center; color: #6e6e73; font-size: 13px;
      margin: 24px 0; position: relative;
    }
    .divider::before, .divider::after {
      content: ''; position: absolute; top: 50%;
      width: 40%; height: 1px; background: #d2d2d7;
    }
    .divider::before { left: 0; }
    .divider::after { right: 0; }
    .btn-buy { background: #34c759; color: white; }
    .btn-buy:hover { background: #30b350; }
    .error {
      background: #fff2f2; color: #e30000; padding: 10px 14px;
      border-radius: 8px; font-size: 14px; margin-bottom: 20px;
      text-align: center;
    }
    .back { display: block; text-align: center; margin-top: 20px; font-size: 14px; color: #6e6e73; }
    .back a { color: #0071e3; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#128218;</div>
    <h1>Paid Chapter</h1>
    <p class="subtitle">Already subscribed? Enter the email you used at checkout.</p>
    ${errorHtml}
    <form method="POST" action="/auth/verify">
      <input type="hidden" name="return_to" value="${returnTo}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required>
      <button type="submit" class="btn btn-primary">Access</button>
    </form>
    <div class="divider">or</div>
    <a href="${paymentLink}" class="btn btn-buy">Subscribe</a>
    <span class="back"><a href="/">&#8592; Back to bookshelf</a></span>
  </div>
</body>
</html>`;
}

// SPA auth script: catches 401s from client-side fetch and forces a full
// reload (or navigation to the article URL) so the login form appears.
const AUTH_SCRIPT = `<script>(function(){var f=window.fetch;window.fetch=function(){var a=arguments;return f.apply(this,a).then(function(r){if(r.status===401){var u=(typeof a[0]==="string"?a[0]:a[0].url)||"";if(u.indexOf("/data/")!==-1){window.location.href=u.replace("/data/","/").replace(".json","")}else{window.location.reload()}return new Promise(function(){})}return r})}})();</script>`;

async function injectAuthScript(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;
  const html = await response.text();
  const modified = html.replace('</head>', AUTH_SCRIPT + '</head>');
  return new Response(modified, {
    status: response.status,
    headers: response.headers,
  });
}

// --- Upstream proxy ---

async function proxyToBook(book, upstreamPath, request) {
  const upstreamUrl = `https://${book.pagesHost}${upstreamPath}`;
  return fetch(new Request(upstreamUrl, request));
}

// --- Main Worker ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // POST /auth/verify
    if (url.pathname === '/auth/verify' && request.method === 'POST') {
      const formData = await request.formData();
      const email = formData.get('email')?.trim().toLowerCase();
      let returnTo = formData.get('return_to') || '/';
      if (!returnTo.startsWith('/')) returnTo = '/';

      if (!email) {
        return new Response(loginPage(env.STRIPE_PAYMENT_LINK, 'Please enter your email.', returnTo), {
          status: 400, headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }

      const customer = await findCustomerByEmail(email, env.STRIPE_SECRET_KEY);
      if (!customer) {
        return new Response(loginPage(env.STRIPE_PAYMENT_LINK, 'No purchase found for this email.', returnTo), {
          status: 403, headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }

      const access = await hasActiveAccess(customer.id, env.STRIPE_SECRET_KEY);
      if (!access) {
        return new Response(loginPage(env.STRIPE_PAYMENT_LINK, 'No active subscription found.', returnTo), {
          status: 403, headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }

      const sessionValue = await createSession(customer.id, env.SESSION_SECRET);
      return new Response(null, {
        status: 302,
        headers: {
          Location: returnTo,
          'Set-Cookie': setCookieHeader(sessionValue, SESSION_MAX_AGE),
        },
      });
    }

    // /auth/logout
    if (url.pathname === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': setCookieHeader('', 0),
        },
      });
    }

    // /<book-slug>/* — match registered paid book
    const segments = url.pathname.split('/').filter(Boolean);
    const slug = segments[0];
    const book = BOOKS[slug];
    if (!book) {
      return new Response('Not Found', { status: 404 });
    }

    // Strip /<slug> prefix to get the upstream path on the Pages project.
    const upstreamPathname = url.pathname.slice(`/${slug}`.length) || '/';
    const upstreamPath = upstreamPathname + url.search;

    if (isFreePath(book, upstreamPathname)) {
      const response = await proxyToBook(book, upstreamPath, request);
      return injectAuthScript(response);
    }

    const session = await verifySession(
      getCookie(request, COOKIE_NAME),
      env.SESSION_SECRET,
    );

    if (session) {
      return proxyToBook(book, upstreamPath, request);
    }

    // Unauthenticated: JSON requests get 401; HTML requests get login form.
    if (url.pathname.endsWith('.json')) {
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const returnTo = url.pathname + url.search;
    return new Response(loginPage(env.STRIPE_PAYMENT_LINK || '#', null, returnTo), {
      status: 401, headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  },
};
