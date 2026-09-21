const {HistoryService}=require('../intelligence/history');
/** V1 endpoint compatibility: new observations live in time series, not graph nodes. */
async function recordObservation(store,raw){return new HistoryService(store).record({...raw,event_type:raw?.event_type||'POSITION'});}
module.exports={recordObservation};
