const {randomUUID}=require('node:crypto');
const M=require('../ontology/model');

// last_confirmed_at is mutable. A short, bounded read snapshot prevents worker
// refreshes from moving unseen rows behind a page cursor (or showing them twice).
class CorrelationPages {
 constructor(){this.snapshots=new Map();this.bytes=0;}
 prune(now=Date.now()){
  for(const [id,s] of this.snapshots)if(s.expires<=now){this.snapshots.delete(id);this.bytes-=s.bytes;}
 }
 page(rows,filters,limit,cursor,truncated=false){
  this.prune();let snapshot,start=0;
  if(cursor){
   let key;
   try{
    M.check(typeof cursor==='string'&&cursor.length<=400,'Invalid cursor');
    key=JSON.parse(Buffer.from(cursor,'base64url').toString());
    M.uuid(key.snapshot);M.uuid(key.id);M.check(M.timestamp(key.at),'Invalid cursor');
   }catch{throw new M.InputError('Invalid correlation cursor');}
   snapshot=this.snapshots.get(key.snapshot);
   if(!snapshot)throw new M.InputError('Correlation page expired; refresh the list',410);
   M.check(snapshot.filters===filters,'Cursor filters changed');
   start=snapshot.rows.findIndex(r=>r.id===key.id&&r.last_confirmed_at===key.at)+1;
   M.check(start>0,'Invalid correlation cursor');
  }else{
   // Serialisation also isolates dates/records from subsequent mutations.
   const json=JSON.stringify(rows),bytes=Buffer.byteLength(json);
   if(bytes>4*1024*1024)throw new M.InputError('Correlation page too large; narrow the filters',413);
   while(this.snapshots.size>=16||this.bytes+bytes>8*1024*1024){const first=this.snapshots.keys().next().value;this.bytes-=this.snapshots.get(first).bytes;this.snapshots.delete(first);}
   snapshot={id:randomUUID(),rows:JSON.parse(json),filters,bytes,expires:Date.now()+300000,as_of:new Date().toISOString(),truncated};
   this.snapshots.set(snapshot.id,snapshot);this.bytes+=bytes;
  }
  const items=snapshot.rows.slice(start,start+limit),last=items.at(-1);
  const next_cursor=start+items.length<snapshot.rows.length?Buffer.from(JSON.stringify({snapshot:snapshot.id,at:last.last_confirmed_at,id:last.id})).toString('base64url'):null;
  return {items,next_cursor,as_of:snapshot.as_of,truncated:snapshot.truncated,coverage:'Bounded screening; absence of a correlation does not establish safety'};
 }
}
module.exports={CorrelationPages};
