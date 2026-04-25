# bookshelf.dev

Landing page for programming books, hosted on Cloudflare Pages at <https://bookshelf.dev>.

## Hosting overview

The root site (`index.html`) is deployed by `.github/workflows/deploy.yml` to a Cloudflare Pages project named `bookshelf-dev` and served on the `bookshelf.dev` zone.

Individual books are deployed from their own repositories and mounted under subpaths of `bookshelf.dev` via Cloudflare Workers that proxy to per-book Pages projects.

## Hosting a book under `bookshelf.dev/<slug>`

Each book lives in its own repo, deploys to its own Cloudflare Pages project, and is exposed on `bookshelf.dev/<slug>` by a small router Worker bound to a route on the `bookshelf.dev` zone.

The pattern, illustrated by the Accessibility Book (`bookshelf.dev/a11y-book`):

1. **Build the static site with the right base path.** The book's CI builds with a hosting base path matching the slug (e.g. DocC's `--hosting-base-path 'a11y-book'`) so all internal links are prefixed with `/a11y-book/`.
2. **Deploy to a dedicated Pages project.** The build is published to a Pages project named after the slug (e.g. `a11y-book`), reachable at `https://<slug>.pages.dev`.
3. **Deploy a router Worker on the `bookshelf.dev` zone.** A Worker is bound to two routes — `bookshelf.dev/<slug>` and `bookshelf.dev/<slug>/*` — and forwards each request to `<slug>.pages.dev`, stripping the `/<slug>` prefix before proxying. It also rewrites `Location` headers on redirects so the prefix is preserved on the public URL.
4. **Add a redirect at the slug root.** The build emits an `index.html` at `/<slug>/` that redirects to the book's entry page (e.g. `/a11y-book/documentation/accessibilitybook/`), so visiting `bookshelf.dev/<slug>` lands on real content.

The book repo therefore owns three things: the GitHub Actions workflow that builds and deploys the Pages project, the Worker source (`router-worker.js`), and the `wrangler.toml` that binds the Worker to its routes on `bookshelf.dev`. The `bookshelf.dev` repo itself does not need to be touched when a new book is added — the Worker registers its own routes on the zone at deploy time.

### Reference: Accessibility Book

- Repo: <https://github.com/akaDuality/AccessibilityBookDocC>
- Pages project: `a11y-book` → `https://a11y-book.pages.dev`
- Worker: `a11y-book-router`, routed on `bookshelf.dev/a11y-book` and `bookshelf.dev/a11y-book/*`
- Public URL: <https://bookshelf.dev/a11y-book/>

## Cloudflare account

All Pages projects, Workers, and the `bookshelf.dev` zone live on the same Cloudflare account. The workflows authenticate via the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, which must be configured in each book's repo as well as this one.
