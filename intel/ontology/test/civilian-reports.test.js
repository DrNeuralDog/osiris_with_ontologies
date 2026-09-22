const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classifyCivilianReport,newsWarning}=require('../../intelligence/civilian-reports');
const at=new Date(Date.now()-60000).toISOString();
const item=(title)=>({title,description:title,published:at,link:'https://example.org/report/1',source_name:'Fixture newsroom',coords:[50,30],location_precision:'settlement',place:{name:'Example',label:'Example district',precision:'settlement'}});
test('civil warnings classify explicit source wording in EN/RU/UA without a weapon position',()=>{
 for(const [text,type] of [['Drone warning: residents urged to take shelter','DRONE_THREAT'],['Воздушная тревога, пройдите в укрытия','AIR_RAID_ALERT'],['Ракетна небезпека, залишайтесь в укриттях','MISSILE_THREAT'],['Residents report hearing explosions','HEARD_EXPLOSION'],['Жители слышали громкий звук','HEARD_SOUND'],['Мешканці чули вибухи','HEARD_EXPLOSION'],['All clear: air raid alert lifted','ALL_CLEAR']])assert.equal(classifyCivilianReport(text,text)?.type,type,text);
});
test('no military movement, launch location, speculation or unrelated article is promoted to a civil warning',()=>{
 for(const text of ['Drone photography festival opens','Missile manufacturer announces earnings','Troops report artillery positions at grid 123','Drone spotted moving east at 80 km/h','Iran may launch missiles next month','Review of the air raid siren app','No explosions were heard'])assert.equal(classifyCivilianReport(text,text),null,text);
 assert.equal(classifyCivilianReport('Economic outlook','Markets stable.\n\n'.repeat(50)+'drone warning: take shelter'),null);
});
test('unknown sound stays unknown and observer location never becomes a sound-source coordinate',()=>{
 const r=newsWarning(item('Жители слышали громкий звук'));
 assert.equal(r.data.subtype,'HEARD_SOUND');assert.equal(r.data.position_semantics,'REPORT_AREA');assert.equal(r.data.sound_source_position_known,false);assert.equal(r.provenance[0].confidence,null);assert.equal(r.provenance[0].kind,'reported');
 assert.equal(r.data.original_text,'Жители слышали громкий звук');assert.ok(r.data.classification.matched_terms.length);
 const {audibility}=require('../../intelligence/air-acoustic');
 assert.equal(audibility({type:'HEARD_SOUND',lat:50,lon:30,data:r.data},{}).status,'UNKNOWN_SOURCE_POSITION');
 assert.equal(audibility({type:'EXPLOSION_REPORT',lat:50,lon:30,data:r.data},{}).status,'UNKNOWN_SOURCE_POSITION');
});
test('country anchors are retained as unlocated text, not incident coordinates',()=>{
 const r=newsWarning({...item('Residents report hearing explosions'),place:null,location_precision:'country-anchor'});
 assert.equal(r.lat,null);assert.equal(r.lon,null);assert.equal(r.data.location_precision,'UNKNOWN');
});
test('same source URL has stable identity and reposts are carriers, not independent confirmations',()=>{
 const a=item('Residents report hearing explosions'),b={...a,title:'Residents still report hearing explosions',also_reported_by:[{source_name:'Reposter',link:'https://example.org/copy'}]};
 assert.equal(newsWarning(a).key,newsWarning(b).key);assert.equal(newsWarning(b).data.independent_sources,null);assert.equal(newsWarning(b).data.carriers.length,1);assert.equal(newsWarning({...a,published:'bad'}),null);
});
