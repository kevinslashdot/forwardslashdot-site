const MODEL = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Anthropic|Perplexity|Google-Extended|Bytespider|Amazonbot|meta-externalagent|cohere|YouBot|Phind|DuckAssist|CCBot|Applebot-Extended/i;
const UNFURL = /Slackbot|Twitterbot|facebookexternalhit|Facebot|Discordbot|TelegramBot|WhatsApp|LinkedInBot|Iframely|embedly|Pinterest|vkShare/i;
const BROWSER = /Mozilla\/|AppleWebKit|Chrome\/|Firefox\/|Safari\//i;

function areaFor(path) {
  if (path === "/instantdomainsearch" || path.startsWith("/instantdomainsearch/")) return "instant_domain_search";
  if (path === "/worldtimeconverter" || path.startsWith("/worldtimeconverter/")) return "world_time_converter";
  return "";
}

async function visitorHash(ip, ua, day) {
  const data = new TextEncoder().encode(day + "\n" + ip + "\n" + ua);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("").slice(0, 32);
}

async function noteModel(request, area) {
  const ua = request.headers.get("user-agent") || "";
  if (!ua || UNFURL.test(ua)) return;
  const dest = request.headers.get("sec-fetch-dest") || "";
  const mode = request.headers.get("sec-fetch-mode") || "";
  const model = MODEL.test(ua) || (!dest && !mode && !BROWSER.test(ua));
  if (!model) return;
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("cf-connecting-ip") || "";
  const country = request.headers.get("cf-ipcountry") || "";
  const visitor = await visitorHash(ip, ua, day);
  const hit = new URL("https://api.forwardslashdot.com/api/hit");
  hit.searchParams.set("area", area);
  hit.searchParams.set("actor", "llm");
  hit.searchParams.set("visitor", visitor);
  hit.searchParams.set("day", day);
  if (/^[A-Za-z0-9]{2}$/.test(country) || country === "T1") hit.searchParams.set("country", country);
  await fetch(hit, { method: "GET" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
    const area = areaFor(path);
    if (request.method === "GET" && area) {
      const task = noteModel(request, area);
      if (ctx && ctx.waitUntil) ctx.waitUntil(task);
      else await task;
    }
    return env.ASSETS.fetch(request);
  },
};
