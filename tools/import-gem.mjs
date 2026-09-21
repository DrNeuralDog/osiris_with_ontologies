// Local CSV conversion; mapping file records the official download's license and columns.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
const [input,mappingFile]=process.argv.slice(2);
if(!input||!mappingFile)throw new Error('Usage: node tools/import-gem.mjs official.csv mapping.json');
if((await stat(input)).size>32*1024*1024)throw new Error('CSV exceeds 32 MiB');
const config=JSON.parse(await readFile(mappingFile,'utf8'));
if(!config.license||!config.attribution||!config.release||!String(config.source_url).startsWith('https://globalenergymonitor.org/'))throw new Error('Official source/license/release metadata required');
const text=await readFile(input,'utf8'),rows=[];let row=[],cell='',quote=false;
for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(!quote&&(ch===','||ch==='\n')){row.push(cell.replace(/\r$/,''));cell='';if(ch==='\n'){rows.push(row);row=[];}}else cell+=ch;}
if(quote)throw new Error('Unclosed CSV quote');if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}const header=rows.shift().map(s=>s.replace(/^\uFEFF/,''));
const columns=config.columns||{};for(const key of ['gem_id','name','lat','lon'])if(!header.includes(columns[key]))throw new Error(`Missing column mapping: ${key}`);
const features=[],seen=new Set();for(const cells of rows){const r=Object.fromEntries(Object.entries(columns).map(([key,col])=>[key,cells[header.indexOf(col)]]));if(!/^[\w.-]{1,100}$/.test(r.gem_id||'')||seen.has(r.gem_id))continue;if(!r.lat?.trim()||!r.lon?.trim())continue;const lat=Number(r.lat),lon=Number(r.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)continue;seen.add(r.gem_id);features.push({type:'Feature',geometry:{type:'Point',coordinates:[lon,lat]},properties:{...r,subtype:config.subtype||'power'}});if(features.length>=20000)throw new Error('Import exceeds 20,000 records; split the official export');}
const dir=path.resolve('data/imports/gem');await mkdir(dir,{recursive:true});const output=path.join(dir,'catalog.geojson');await writeFile(output,JSON.stringify({type:'FeatureCollection',metadata:{license:config.license,attribution:config.attribution,release:config.release,source_url:config.source_url},features}));console.log(`Imported ${features.length} records: ${output}. No PostgreSQL objects created.`);
