param([string]$BaseUrl = 'http://localhost:3000')
$ErrorActionPreference = 'Stop'
function Assert-True($condition, [string]$message) { if (-not $condition) { throw $message } }
function Expect-Status([string]$path, [int]$expected) {
    $actual = 0
    try { $actual = (Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl$path").StatusCode }
    catch { if ($_.Exception.Response) { $actual = [int]$_.Exception.Response.StatusCode } else { throw } }
    Assert-True ($actual -eq $expected) "$path expected $expected, got $actual"
}
Expect-Status '/' 200
$health = Invoke-RestMethod "$BaseUrl/api/health"
Assert-True ($health.status -eq 'serving') 'Frontend is not serving'
$policies = Invoke-RestMethod "$BaseUrl/api/intelligence/policies"
Assert-True ($policies.freshness.aircraft.fresh -eq 300) 'Missing intelligence policies'
$sources = Invoke-RestMethod "$BaseUrl/api/intelligence/sources?scope=all&limit=200"
Assert-True ($sources.items.Count -gt 0) 'No sources registered'
$correlations = Invoke-RestMethod "$BaseUrl/api/intelligence/correlations?status=all&limit=5"
foreach ($c in $correlations.items) {
    $detail = Invoke-RestMethod "$BaseUrl/api/intelligence/correlations/$($c.id)"
    Assert-True ($detail.evidence.Count -ge 2) 'Correlation evidence missing'
    Assert-True ($null -eq $detail.confidence) 'Unexpected fabricated numeric confidence'
}
$objects = Invoke-RestMethod "$BaseUrl/api/ontology/objects?limit=1"
Assert-True ($objects.objects.Count -gt 0) 'No persistent objects'
$id = $objects.objects[0].id
$graph = Invoke-RestMethod "$BaseUrl/api/ontology/objects/$id/graph?depth=1"
Assert-True ($graph.root_id -eq $id) 'Graph root identity mismatch'
$history = Invoke-RestMethod "$BaseUrl/api/ontology/objects/$id/history?limit=5"
Assert-True ($history.object_id -eq $id) 'History identity mismatch'
$evidence = Invoke-RestMethod "$BaseUrl/api/ontology/objects/$id/provenance"
Assert-True ($evidence.object_id -eq $id) 'Provenance identity mismatch'
Expect-Status "/api/ontology/objects/$id/history?limit=100000" 400
Expect-Status "/api/ontology/objects/$id/history?from=1900-01-01T00:00:00Z" 400
Expect-Status "/api/ontology/objects/$id/graph?depth=100000" 400
Expect-Status '/api/ontology/objects/00000000-0000-0000-0000-000000000001/history' 404
Expect-Status '/api/intelligence/correlations?limit=100000' 400
Expect-Status '/api/intelligence/source-reports' 404
Expect-Status '/api/intelligence/sources?url=http://127.0.0.1' 400
[PSCustomObject]@{ result = 'PASS'; source_count = $sources.items.Count; correlations_sampled = $correlations.items.Count; object_id = $id; history_sampled = $history.items.Count; timestamp = (Get-Date).ToString('o') } | ConvertTo-Json
