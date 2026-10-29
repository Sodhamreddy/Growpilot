# Production deployment

The web app, background worker, and browser crawler must run as separate persistent services. `compose.production.yml` runs all three with shared image storage, while PostgreSQL and Redis are provided through your environment.

1. Copy `.env.example` to `.env.production` and set a production PostgreSQL URL, Redis URL, unique encryption/authentication secrets, and the public HTTPS `APP_URL`. Use the same secrets for web and worker. The file is ignored by Git and must not be committed.
2. Configure your AI provider. Configure `RESEND_API_KEY` and a verified `EMAIL_FROM` for password resets. Configure Google/Meta credentials only for integrations you use, with OAuth callbacks pointing to the production HTTPS domain.
3. Back up the database. Apply the existing database migrations using the production environment before starting the new application version. `docker compose -f compose.production.yml run --rm --no-deps web pnpm db:migrate` applies them using the same environment as the app.
4. Build and start with `docker compose -f compose.production.yml up -d --build`. Put an HTTPS reverse proxy in front of port 3002. The crawler is internal and has no public port.
5. Check `/api/health` for web dependencies and `/api/health?deep=1` for the worker and configured crawler. Use the deep endpoint in operational monitoring; use basic health for web routing so users retain access to recovery controls when a background service is unavailable.
6. Run a staging smoke test: sign in, switch clients, reset a password, generate and revise a draft, rerun QA, plan social content, sync reviews, then publish one explicitly approved test post. Check provider account permissions and callback URLs before allowing scheduled publishing.

Local image files use the `post-images` volume shared by web and worker. Back it up with the database. Instagram publishing needs publicly reachable image storage; configure the existing Supabase storage settings for that workflow. Never run `down -v` against a production installation unless you intend to delete its stored images.

Google Places is optional. Manual review entry/import works without it. Google Business Profile synchronization and direct replies require eligible API access and an authorized business connection. A saved Google Maps link cannot guarantee automatic access to every review.

Docker image builds and real provider OAuth/publishing must be verified on the deployment host. A successful local TypeScript build does not verify these external services.
