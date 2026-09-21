import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const script=path.resolve('tools/import-gem.mjs');
function run(csv:string,metadata:Record<string,unknown>){const dir=mkdtempSync(path.join(tmpdir(),'osiris-gem-test-'));try{const input=path.join(dir,'source.csv'),mapping=path.join(dir,'mapping.json');writeFileSync(input,csv);writeFileSync(mapping,JSON.stringify(metadata));const p=spawnSync(process.execPath,[script,input,mapping],{cwd:dir,encoding:'utf8'});const out=path.join(dir,'data/imports/gem/catalog.geojson');return {status:p.status,error:p.stderr,output:existsSync(out)?JSON.parse(readFileSync(out,'utf8')):null};}finally{if(!dir.startsWith(path.join(tmpdir(),'osiris-gem-test-')))throw new Error('Unsafe fixture path');rmSync(dir,{recursive:true,force:true});}}
const metadata={license:'CC BY 4.0 (test fixture)',attribution:'Fixture',release:'2026-09',source_url:'https://globalenergymonitor.org/test-fixture',columns:{gem_id:'ID',name:'Name',lat:'Lat',lon:'Lon'}};
it('imports quoted CSV, stable IDs and license metadata without database access',()=>{const r=run('ID,Name,Lat,Lon\r\nG001,"A, ""quoted""",51,3\r\n',metadata);expect(r.status).toBe(0);expect(r.output.features[0].properties.name).toBe('A, "quoted"');expect(r.output.features[0].properties.gem_id).toBe('G001');expect(r.output.metadata.license).toContain('CC BY');});
it('does not create identity from names or empty coordinates',()=>{const r=run('ID,Name,Lat,Lon\n,No ID,51,3\nG001,No coords,,\nG002,Valid,52,4\nG002,Duplicate,52,4',metadata);expect(r.output.features).toHaveLength(1);expect(r.output.features[0].properties.gem_id).toBe('G002');});
it('refuses missing license evidence',()=>{const r=run('ID,Name,Lat,Lon\nG1,X,51,3',{...metadata,license:''});expect(r.status).not.toBe(0);expect(r.output).toBeNull();});
