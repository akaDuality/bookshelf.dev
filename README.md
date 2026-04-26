# bookshelf.dev

Landing page for programming books, hosted on Cloudflare Pages at <https://bookshelf.dev>.

## Hosting overview

The root site (`index.html`) is deployed by `.github/workflows/deploy.yml` to a Cloudflare Pages project named `bookshelf-dev` and served on the `bookshelf.dev` zone.

Individual books are deployed from their own repositories to their own per-book Pages projects, then mounted under subpaths of `bookshelf.dev` via Cloudflare Workers. There are two flavors:

- **Free books** keep a small router Worker in their own repo. The Worker proxies `bookshelf.dev/<slug>/*` to `<slug>.pages.dev`. Example: the Accessibility Book.
- **Paid books** are routed through the centralized `bookshelf-paywall` Worker that lives in this repo. It enforces the Stripe paywall, then proxies authenticated requests to the book's Pages project. Example: the Testing Book.

## Free book pattern

Each book lives in its own repo, deploys to its own Cloudflare Pages project, and is exposed on `bookshelf.dev/<slug>` by a small router Worker bound to a route on the `bookshelf.dev` zone.

The pattern, illustrated by the Accessibility Book (`bookshelf.dev/a11y-book`):

1. **Build the static site with the right base path.** The book's CI builds with a hosting base path matching the slug (e.g. DocC's `--hosting-base-path 'a11y-book'`) so all internal links are prefixed with `/a11y-book/`.
2. **Deploy to a dedicated Pages project.** The build is published to a Pages project named after the slug (e.g. `a11y-book`), reachable at `https://<slug>.pages.dev`.
3. **Deploy a router Worker on the `bookshelf.dev` zone.** A Worker is bound to two routes — `bookshelf.dev/<slug>` and `bookshelf.dev/<slug>/*` — and forwards each request to `<slug>.pages.dev`, stripping the `/<slug>` prefix before proxying. It also rewrites `Location` headers on redirects so the prefix is preserved on the public URL.
4. **Add a redirect at the slug root.** The build emits an `index.html` at `/<slug>/` that redirects to the book's entry page (e.g. `/a11y-book/documentation/accessibilitybook/`), so visiting `bookshelf.dev/<slug>` lands on real content.

The book repo therefore owns three things: the GitHub Actions workflow that builds and deploys the Pages project, the Worker source (`router-worker.js`), and the `wrangler.toml` that binds the Worker to its routes on `bookshelf.dev`. The `bookshelf.dev` repo itself does not need to be touched when a free book is added — the Worker registers its own routes on the zone at deploy time.

### Reference: Accessibility Book

- Repo: <https://github.com/akaDuality/AccessibilityBookDocC>
- Pages project: `a11y-book` → `https://a11y-book.pages.dev`
- Worker: `a11y-book-router`, routed on `bookshelf.dev/a11y-book` and `bookshelf.dev/a11y-book/*`
- Public URL: <https://bookshelf.dev/a11y-book/>

## Paid book pattern

Paid books are gated by the `bookshelf-paywall` Worker (this repo, `cloudflare/paywall-worker.js`). The Worker is bound to `bookshelf.dev/<slug>`, `bookshelf.dev/<slug>/*`, and `bookshelf.dev/auth/*` for every paid book, and:

1. Serves the login form at `/auth/verify` and clears the session at `/auth/logout`.
2. Verifies the visitor's signed session cookie (HMAC-signed JWT-style token in `bookshelf_session`).
3. Looks up the visitor's email in Stripe (`/v1/customers/search`) and accepts any active subscription or non-refunded charge as proof of access — a single subscription grants access to all paid books on `bookshelf.dev`.
4. Proxies authenticated requests to the book's `<slug>.pages.dev` project.

The session cookie is scoped to `Path=/` so a single login covers every paid book on the domain, current and future.

### Reference: Testing Book

- Repo: <https://github.com/akaDuality/testing-book>
- Pages project: `testing-book` → `https://testing-book.pages.dev`
- Public URL: <https://bookshelf.dev/testing-book/>
- Routing & paywall: handled here in `cloudflare/paywall-worker.js`

## Adding a new book

Pick a unique URL slug for the book (e.g. `my-book` → `bookshelf.dev/my-book`). Decide free or paid:

- **Free**: every visitor reads the book directly. The book repo owns its router Worker.
- **Paid**: gated by the centralized `bookshelf-paywall` Worker in this repo. Stripe customers with an active subscription or non-refunded one-time charge get in.

### 1. Set up the book repo

Same regardless of free vs paid:

1. Create the GitHub repo for the book and add its content (DocC project, static HTML, etc.).
2. Add a GitHub Actions workflow that:
   - Builds the static site with `--hosting-base-path '<slug>'` so internal links carry the prefix.
   - Emits an `index.html` at the build root that redirects to the book's entry page using an **absolute** path (e.g. `/<slug>/documentation/<target>/`). Relative paths break when the URL has no trailing slash.
   - Deploys to a Cloudflare Pages project named `<slug>` (creates it on first run with `pages project create`).
3. Add the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (same values as the other book repos). The token needs Workers Scripts:Edit, Pages:Edit, and (for free books) Workers Routes:Edit on the `bookshelf.dev` zone.
4. Push to `main`. Verify the book is reachable at `https://<slug>.pages.dev`.

Reference workflows: [a11y-book](https://github.com/akaDuality/AccessibilityBookDocC/blob/main/.github/workflows/update_docs.yml), [testing-book](https://github.com/akaDuality/testing-book/blob/main/.github/workflows/update_docs.yml).

### 2a. Wire up a free book

In the book repo, add `cloudflare/router-worker.js` and `cloudflare/wrangler.toml` modeled on the a11y-book setup. The Worker:
- Strips the `/<slug>` prefix and proxies to `<slug>.pages.dev`.
- Rewrites `Location` headers on upstream redirects to preserve the prefix on the public URL.

`wrangler.toml` binds the Worker to two routes on the `bookshelf.dev` zone:

```toml
routes = [
  { pattern = "bookshelf.dev/<slug>", zone_name = "bookshelf.dev" },
  { pattern = "bookshelf.dev/<slug>/*", zone_name = "bookshelf.dev" },
]
```

Add a "Deploy router Worker" step to the workflow that runs `wrangler deploy --config cloudflare/wrangler.toml`. Push — the Worker self-registers on the zone.

This repo (`bookshelf.dev`) does **not** need to change for a free book.

### 2b. Wire up a paid book

The book repo only deploys static content — no Worker, no Pages Function. The paywall is enforced here.

In **this** repo:

1. **Register the book** in `cloudflare/paywall-worker.js`'s `BOOKS` map. Pick which article slug prefixes are free (e.g. `0-`, `1-`) and which individual articles are free regardless of prefix:
   ```js
   const BOOKS = {
     '<slug>': {
       pagesHost: '<slug>.pages.dev',
       freeSections: ['0-', '1-'],
       freeArticles: [],
     },
   };
   ```
2. **Add routes** for the book in `cloudflare/wrangler.toml`:
   ```toml
   { pattern = "bookshelf.dev/<slug>", zone_name = "bookshelf.dev" },
   { pattern = "bookshelf.dev/<slug>/*", zone_name = "bookshelf.dev" },
   ```
3. Push to `main`. The workflow redeploys `bookshelf-paywall` with the new routes.

For the **first** paid book, also set the three Stripe-related Worker secrets on `bookshelf-paywall` (see [Worker secrets](#worker-secrets) below). Subsequent paid books reuse the same Stripe account, so secrets don't need to change.

### 3. Add the book to the landing page

Edit `index.html` in this repo: add a new card in the `<section class="books">` block. Use a sibling card as a template — title, description, topics, "Read for Free" / "Read with Subscription" CTA pointing to `https://bookshelf.dev/<slug>`, cover image. Place the cover PNG next to `index.html` (e.g. `<slug>-cover.png`) — don't hotlink from the upstream Pages project, since covers are landing-page assets, not book assets.

Push. The bookshelf.dev landing page redeploys.

### 4. Smoke test

- `https://bookshelf.dev/<slug>/` lands on the book entry page.
- `https://bookshelf.dev/<slug>/<deep article>` works.
- Free articles (paid book) load without login.
- Paid articles (paid book) show the login form. Logging in with a paid email persists across navigation.
- Cover image and CTA on the landing page resolve correctly.

## Backdoor caveat

The upstream `<slug>.pages.dev` URLs are publicly reachable on Cloudflare's network. Anyone who learns a URL can read paid content directly, bypassing the paywall Worker. The URLs are not advertised anywhere — visitors only see `bookshelf.dev/<slug>/...` — but this is security through obscurity.

If a `.pages.dev` URL leaks (search-indexed, shared, enumerated), close the hole with **Cloudflare Access** in front of the Pages project:

1. Cloudflare Zero Trust dashboard → Access → Service Auth → Service Tokens → create one named `bookshelf-paywall`. Copy Client ID + Secret.
2. Access → Applications → Add Self-hosted application → domain `<slug>.pages.dev` → policy: action **Service Auth**, selector the token from step 1.
3. Add Worker secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` on `bookshelf-paywall`.
4. Add `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers to the upstream fetch in `proxyToBook` (see comment in `paywall-worker.js`).

One service token + Access policy works for every paid book.

## Worker secrets

The paywall Worker reads these secrets from its environment. Set them with `wrangler secret put <NAME> --config cloudflare/wrangler.toml` or in the Cloudflare dashboard:

| Secret | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret API key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_PAYMENT_LINK` | Stripe Payment Link URL shown on the login screen |
| `SESSION_SECRET` | Random string used to HMAC-sign session cookies |

## Cloudflare account

All Pages projects, Workers, and the `bookshelf.dev` zone live on the same Cloudflare account. The workflows authenticate via the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, which must be configured in each book's repo as well as this one.
