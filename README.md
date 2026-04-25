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

### Adding a paid book

1. Deploy the static site to its own `<slug>.pages.dev` Pages project (workflow in the book's own repo, the same as a free book — but **without** any Worker step).
2. Register the slug and free-content rules in `cloudflare/paywall-worker.js`'s `BOOKS` map.
3. Add the routes `bookshelf.dev/<slug>` and `bookshelf.dev/<slug>/*` to `cloudflare/wrangler.toml`.
4. Push to `main` — the GitHub Actions workflow redeploys the paywall Worker with the new routes.

### Reference: Testing Book

- Repo: <https://github.com/akaDuality/testing-book>
- Pages project: `testing-book` → `https://testing-book.pages.dev`
- Public URL: <https://bookshelf.dev/testing-book/>
- Routing & paywall: handled here in `cloudflare/paywall-worker.js`

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
