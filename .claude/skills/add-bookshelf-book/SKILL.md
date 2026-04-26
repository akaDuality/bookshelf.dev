---
name: add-bookshelf-book
description: Use this skill when the user wants to add a new book to bookshelf.dev (free or paid). Walks through creating/wiring the book repo, registering it with the centralized paywall (paid) or deploying its own router (free), adding it to the bookshelf.dev landing page, and smoke-testing. Triggers on "add book to bookshelf", "new book on bookshelf.dev", "publish book under bookshelf.dev", or similar.
---

# Adding a new book to bookshelf.dev

This skill guides through the full workflow of attaching a new book to <https://bookshelf.dev>. The bookshelf.dev system is documented in detail at `/Users/rubanov/Developer/Books/bookshelf.dev/README.md` — read that first if anything below is unclear.

## 0. Gather inputs

Before writing any files, get from the user (ask if not already known):

- **Slug** — the URL segment. Lowercase, hyphenated. Example: `my-book` → `bookshelf.dev/my-book`. Must be unique on `bookshelf.dev`.
- **Free or paid?**
  - *Free*: anyone can read. The book repo owns its router Worker.
  - *Paid*: gated by the centralized `bookshelf-paywall` Worker in the bookshelf.dev repo.
- **Repo location** — path to the book's git repo, or "create a new one".
- **Content type** — DocC SwiftPM target (most common), or static HTML.
- **Display info for the landing page** — title, short description, topic tags, "Free" or "Paid" badge, cover PNG file.

If the book is paid, also confirm: are the Stripe secrets (`STRIPE_SECRET_KEY`, `STRIPE_PAYMENT_LINK`, `SESSION_SECRET`) already set on `bookshelf-paywall`? They only need to be set once. Check Cloudflare dashboard → Workers & Pages → `bookshelf-paywall` → Settings → Variables.

## 1. Set up the book repo

Same regardless of free/paid.

### 1a. Workflow

Create `.github/workflows/update_docs.yml` modeled on:
- DocC: `/Users/rubanov/Developer/Books/AccessibilityBookDocC/.github/workflows/update_docs.yml` (free reference) or `/Users/rubanov/Developer/Books/testing-book/.github/workflows/update_docs.yml` (paid reference).
- Static HTML: `/Users/rubanov/Developer/Books/bookshelf.dev/.github/workflows/deploy.yml`.

The workflow must:
- Build the static site with `--hosting-base-path '<slug>'` so internal links carry the prefix. (DocC step.)
- Emit an `index.html` at the build root that redirects to the book's entry page using an **absolute** path: `/<slug>/documentation/<target>/`. **Do not** use a relative path like `./documentation/<target>/` — it breaks when the URL has no trailing slash.
- Run `pages project create <slug> --production-branch main` with `continue-on-error: true` (idempotent on re-runs).
- Run `pages deploy <build-dir> --project-name=<slug>`.
- For **free** books only: also run `wrangler deploy --config cloudflare/wrangler.toml` to deploy the router Worker.
- For **paid** books: do **NOT** add a Worker step here — the paywall lives in the bookshelf.dev repo.

### 1b. GitHub repo secrets

Add the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (same values as the other book repos). The token needs Workers Scripts:Edit, Pages:Edit, and (for free books) Workers Routes:Edit on the `bookshelf.dev` zone.

Tell the user to add these manually if they haven't been added — there's no API path Claude can take for repo secrets without elevated GitHub permissions.

### 1c. First push

Push to `main`. Verify the build succeeds and the book is reachable at `https://<slug>.pages.dev`.

## 2a. Wire up a free book

Skip this section for paid books — go to 2b.

In the book repo, create:

- `cloudflare/router-worker.js` — model on `/Users/rubanov/Developer/Books/AccessibilityBookDocC/cloudflare/router-worker.js`. Replace `a11y-book` with the new slug and `a11y-book.pages.dev` with `<slug>.pages.dev`. Keep the Location-header rewriting logic — it fixes DocC SPA links that lose the prefix.
- `cloudflare/wrangler.toml`:
  ```toml
  name = "<slug>-router"
  main = "router-worker.js"
  compatibility_date = "2024-01-01"

  routes = [
    { pattern = "bookshelf.dev/<slug>", zone_name = "bookshelf.dev" },
    { pattern = "bookshelf.dev/<slug>/*", zone_name = "bookshelf.dev" },
  ]
  ```

Push. The Worker self-registers its routes on `bookshelf.dev`.

The bookshelf.dev repo does **not** need any change for a free book (other than the landing page card in step 3).

## 2b. Wire up a paid book

Skip this section for free books — already in 2a.

Edit two files in `/Users/rubanov/Developer/Books/bookshelf.dev/`:

### Register the book in the paywall worker

In `cloudflare/paywall-worker.js`, add an entry to the `BOOKS` map:

```js
const BOOKS = {
  '<slug>': {
    pagesHost: '<slug>.pages.dev',
    freeSections: ['0-', '1-'],   // article slug prefixes that are free
    freeArticles: [],             // individual article slugs that are free regardless
  },
  // existing entries remain
};
```

Confirm the free-content rules with the user. The defaults `['0-', '1-']` match the testing-book convention — first two numbered sections are free.

### Add routes

In `cloudflare/wrangler.toml`, add:

```toml
{ pattern = "bookshelf.dev/<slug>", zone_name = "bookshelf.dev" },
{ pattern = "bookshelf.dev/<slug>/*", zone_name = "bookshelf.dev" },
```

Keep the existing `bookshelf.dev/auth/*` route — it's shared.

Push. The workflow redeploys `bookshelf-paywall` with the new routes.

If this is the **first** paid book on bookshelf.dev, also remind the user to set the Worker secrets (`STRIPE_SECRET_KEY`, `STRIPE_PAYMENT_LINK`, `SESSION_SECRET`) on `bookshelf-paywall` via Cloudflare dashboard or `wrangler secret put`.

## 3. Add the book to the landing page

Edit `/Users/rubanov/Developer/Books/bookshelf.dev/index.html`. Inside `<section class="books">`, add a new `<div class="book-card-outer">` modeled on an existing card. Set:

- Cover image: place the PNG next to `index.html` (e.g. `<slug>-cover.png`) and reference it as a relative path. Don't hotlink from upstream — covers are landing-page assets.
- Title, badge (`badge-free` or `badge-paid`), book meta (pages, language), description, topic tags.
- CTA button: `<a href="https://bookshelf.dev/<slug>" class="cta-btn">Read for Free</a>` (or "Read with Subscription" for paid).
- Author block — copy from a sibling card unless told otherwise.

Push. The bookshelf.dev landing page redeploys.

## 4. Smoke test

Walk through these checks with the user (browser-based):

- `https://bookshelf.dev/<slug>/` lands on the book entry page (after the redirect index.html resolves).
- `https://bookshelf.dev/<slug>/<deep-article>` works — including refresh on the deep URL.
- For paid books:
  - Free articles (e.g. `/0-…`, `/1-…`) load without login.
  - Paid articles show the login form. Logging in with a paid email persists the session across navigation.
  - The Subscribe button on the login form points to a real Stripe URL, not `bookshelf.dev/undefined` (that means `STRIPE_PAYMENT_LINK` isn't set on the worker).
- The new card is visible on `https://bookshelf.dev/`, the cover image loads, and the CTA navigates correctly.

## 5. Common pitfalls

- **Route conflict on Worker deploy** — if a previous Worker on `bookshelf.dev` has overlapping routes, the new deploy fails. Tell the user to delete the conflicting Worker in the Cloudflare dashboard, then re-run the workflow.
- **Relative redirect in the entry `index.html`** — DocC's default redirect uses `./documentation/<target>/`. This breaks when the URL is `bookshelf.dev/<slug>` (no trailing slash). Always use an absolute path.
- **Hotlinked covers** — the previous setup pulled covers from `rubanov.dev/...`. Always copy covers into the bookshelf.dev repo, otherwise they break when the upstream URL is reorganized.
- **Stripe secrets missing** — if the Subscribe button 404s on the login page, `STRIPE_PAYMENT_LINK` is unset on `bookshelf-paywall`.
- **Paid book accessed before secrets are set** — login attempts will fail with opaque errors. Set secrets before announcing the book.

## 6. References

- bookshelf.dev README: `/Users/rubanov/Developer/Books/bookshelf.dev/README.md`
- Free book example (a11y-book): `/Users/rubanov/Developer/Books/AccessibilityBookDocC/`
- Paid book example (testing-book): `/Users/rubanov/Developer/Books/testing-book/`
- Centralized paywall: `/Users/rubanov/Developer/Books/bookshelf.dev/cloudflare/paywall-worker.js`
