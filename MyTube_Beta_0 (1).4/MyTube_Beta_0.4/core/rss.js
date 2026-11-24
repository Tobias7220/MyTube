// YouTube's public channel feeds (Atom XML, latest ~15 uploads). Contacts YouTube directly, so it is only a fallback.
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const pick = (e, re) => (e.match(re) || [])[1];

function parseRss(xml, channelId) {
  const items = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1], id = pick(e, /<yt:videoId>([\w-]+)<\/yt:videoId>/);
    if (!id) continue;
    const pub = Date.parse(pick(e, /<published>([^<]+)<\/published>/));
    items.push({
      id, title: decode(pick(e, /<title>([\s\S]*?)<\/title>/) || ''), channelId, channelName: decode(pick(e, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || ''),
      thumbnail: pick(e, /<media:thumbnail url="([^"]+)"/) || '', duration: 0, views: +(pick(e, /<media:statistics views="(\d+)"/) || 0),
      published: isNaN(pub) ? null : pub, isShort: false, // the feed does not say whether it is a Short
    });
  }
  return items;
}
async function fetchRss(channelId, f = fetch) {
  const r = await f('https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(channelId), { headers: { 'user-agent': 'MyTube/0.4' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseRss(await r.text(), channelId);
}
module.exports = { parseRss, fetchRss };
