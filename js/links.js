// Turns a pasted link into item details. Steam store links give a name (from
// the URL slug) and cover art (from Steam's public CDN) without any API call,
// since Steam's API does not allow requests from other websites.

export function parseLink(input) {
  const text = (input || "").trim();
  if (!text) return null;

  const steam =
    text.match(/store\.steampowered\.com\/app\/(\d+)(?:\/([^/?#\s]+))?/i) ||
    text.match(/steamcommunity\.com\/app\/(\d+)()/i) ||
    text.match(/^steam:\/\/(?:store|run)\/(\d+)()/i);
  if (steam) {
    const appId = steam[1];
    let name = "";
    if (steam[2]) {
      try {
        name = decodeURIComponent(steam[2]);
      } catch {
        name = steam[2];
      }
      name = name.replace(/_+/g, " ").trim();
    }
    return {
      kind: "steam",
      appId,
      name,
      url: `https://store.steampowered.com/app/${appId}/`,
      image: steamCover(appId),
    };
  }

  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!url.hostname.includes(".")) return null;
    return { kind: "link", name: "", url: url.href, image: "" };
  } catch {
    return null;
  }
}

export function steamCover(appId) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
}

// Older CDN path, tried when the main one fails to load.
export function steamCoverFallback(appId) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}
