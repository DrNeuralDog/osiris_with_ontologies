const ALLOWED_HOSTS = new Set(['query.wikidata.org', 'data.opensanctions.org', 'www.wikidata.org', 'ip-api.com', 'stat.ripe.net']);
let observer=null;
const setSourceObserver=fn=>{observer=fn;};
const reportSource=(host,sample)=>{if(observer&&ALLOWED_HOSTS.has(host))void observer(host,sample);};
/** Follow only bounded redirects whose destination is independently allowlisted. */
async function fetchSource(input, options = {}, hosts = ALLOWED_HOSTS) {
  let url = new URL(input);
  const start=Date.now(),host=url.hostname;
  try {
  for (let hop = 0; hop < 5; hop++) {
    if (!hosts.has(url.hostname) || url.username || url.password || url.port || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'ip-api.com')) throw new Error('Blocked source URL');
    const response = await fetch(url.toString(), { ...options, redirect: 'manual' });
    if (![301,302,303,307,308].includes(response.status)) {reportSource(host,{ok:response.ok,latency_ms:Date.now()-start,http_status:response.status,error_category:response.ok?null:`HTTP_${response.status}`});return response;}
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Source redirect has no location');
    url = new URL(location, url);
  }
  throw new Error('Too many source redirects');
  }catch(error){reportSource(host,{ok:false,latency_ms:Math.min(300000,Date.now()-start),error_category:error.name==='TimeoutError'?'TIMEOUT':'NETWORK_OR_BLOCKED'});throw error;}
}
module.exports = { fetchSource, ALLOWED_HOSTS, setSourceObserver, reportSource };
