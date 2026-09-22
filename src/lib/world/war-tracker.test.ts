import {it,expect,vi,beforeEach,afterEach} from 'vitest';
vi.mock('./war-tracker-client',()=>({warTrackerJSON:vi.fn()}));
beforeEach(()=>{vi.resetModules();vi.stubEnv('WAR_TRACKER_API_KEY','');});
afterEach(()=>vi.unstubAllEnvs());
it('tries documented public civil-alert access without a mandatory key and paginates with cursor alone',async()=>{
 const {warTrackerJSON}=await import('./war-tracker-client');const mock=vi.mocked(warTrackerJSON);
 mock.mockReset().mockResolvedValueOnce({events:[{id:1,date:'2026-09-22T10:00:00Z',event_type:'Air raid alert'}],next_cursor:'fixture'}).mockResolvedValueOnce({events:[]});
 const {warTracker}=await import('./conflict');const r=await warTracker();expect(r.status).toBe('AVAILABLE');expect(r.records).toHaveLength(1);expect(mock.mock.calls[0][1]).toBe('');expect(mock.mock.calls[0][0].get('event_type')).toBe('Air raid alert');expect([...mock.mock.calls[1][0].keys()]).toEqual(['cursor']);
});
it('reports provider access refusal without spoofing browser origin or making a payment',async()=>{
 const {warTrackerJSON}=await import('./war-tracker-client');vi.mocked(warTrackerJSON).mockReset().mockRejectedValue(new Error('HTTP_402'));
 const {warTracker,warTrackerCapability}=await import('./conflict');expect((await warTracker()).status).toBe('ACCESS_REQUIRED');expect(warTrackerCapability().credential_state).toBe('ACCESS_REQUIRED');
});
