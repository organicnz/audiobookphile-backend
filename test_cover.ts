const SUPABASE_URL = "https://iambzzclljayqdxkeepy.supabase.co";

async function test() {
  const url =
    `${SUPABASE_URL}/functions/v1/api/items/123/cover?width=400&format=jpeg`;
  const res = await fetch(url, { redirect: "manual" });
  console.log("Status:", res.status);
  console.log("Location:", res.headers.get("location"));

  if (res.headers.get("location")) {
    const imgRes = await fetch(res.headers.get("location")!);
    console.log("Image Status:", imgRes.status);
    console.log("Image Body:", await imgRes.text());
  }
}
test();
