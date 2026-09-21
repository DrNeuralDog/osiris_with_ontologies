const ALLOWED_HOSTS = new Set(['query.wikidata.org', 'data.opensanctions.org', 'www.wikidata.org', 'ip-api.com', 'stat.ripe.net']);
/** Follow only bounded redirects whose destination is independently allowlisted. */
async function fetchSource(input, options = {}, hosts = ALLOWED_HOSTS) {
  let url = new URL(input);
  for (let hop = 0; hop < 5; hop++) {
    if (!hosts.has(url.hostname) || url.username || url.password || url.port || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'ip-api.com')) throw new Error('Blocked source URL');
    const response = await fetch(url.toString(), { ...options, redirect: 'manual' });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Source redirect has no location');
    url = new URL(location, url);
  }
  throw new Error('Too many source redirects');
}
module.exports = { fetchSource, ALLOWED_HOSTS };
