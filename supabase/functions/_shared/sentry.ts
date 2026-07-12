import * as Sentry from "@sentry/deno";

Sentry.init({
  dsn:
    "https://73b955343fb09bc7770dc93fa7d2c18a@o4509901022691328.ingest.de.sentry.io/4511573264236624",
  tracesSampleRate: 1.0,
});

export { Sentry };
