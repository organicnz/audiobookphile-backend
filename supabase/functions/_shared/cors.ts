export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // x-refresh-token is required for the /authorize silent-refresh path used by
  // the iOS Audiobookshelf client to avoid daily re-authentication prompts.
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-refresh-token",
};
