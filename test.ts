import { mapBookForMobile } from "./supabase/functions/api/mappers.ts";
console.log(
  mapBookForMobile({
    id: "1",
    title: "Test",
    created_at: "2026-07-21T00:00:00Z",
  }),
);
