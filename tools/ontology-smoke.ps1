param([switch]$Restart)
$ErrorActionPreference = 'Stop'
function Require($Condition, $Message) { if (-not $Condition) { throw $Message } }
function HttpStatus($Url) {
  try { return [int](Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 15).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }; throw }
}
function WaitIntel {
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try { $health = Invoke-RestMethod http://localhost:4000/health -TimeoutSec 3; if ($health.database -eq 'ok') { return } } catch { }
    Start-Sleep -Seconds 1
  }
  throw 'PostgreSQL/intel readiness timeout'
}
WaitIntel
Require ((HttpStatus 'http://localhost:3000') -eq 200) 'Frontend unavailable'
$body = @{type='company';id='Q312'} | ConvertTo-Json
$first = Invoke-RestMethod http://localhost:3000/api/ontology/resolve -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 65
$second = Invoke-RestMethod http://localhost:3000/api/ontology/resolve -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 65
Require ($first.root_id -eq $second.root_id) 'Canonical object changed on duplicate resolution'
Require ($second.nodes.Count -gt 1 -and $second.links.Count -gt 0) 'No source relationships available'
Require (@($second.links.id | Sort-Object -Unique).Count -eq $second.links.Count) 'Duplicate links'
Require (@($second.nodes.id | Sort-Object -Unique).Count -eq $second.nodes.Count) 'Duplicate nodes'
$id = $second.root_id
$saved = Invoke-RestMethod "http://localhost:3000/api/ontology/objects/$id"
Require ($saved.provenance.Count -gt 0) 'Missing provenance'
$traversal = Invoke-RestMethod "http://localhost:3000/api/ontology/objects/$id/graph?depth=2&max_nodes=100&max_edges=250"
Require ($traversal.nodes.Count -le 100 -and $traversal.links.Count -le 250) 'Traversal exceeded limits'
$target = $second.links | Where-Object { $_.source -eq $id } | Select-Object -First 1 -ExpandProperty target
$reverse = Invoke-RestMethod "http://localhost:3000/api/ontology/objects/$target/relationships?direction=in"
Require ($reverse.links.source -contains $id) 'Reverse relationship missing'
Require ((HttpStatus "http://localhost:3000/api/ontology/objects/$id/graph?depth=100000") -eq 400) 'Depth validation failed'
Require ((HttpStatus 'http://localhost:3000/api/ontology/objects/11111111-2222-3333-4444-555555555555') -eq 404) 'Missing object did not return 404'
if ($Restart) {
  docker compose restart osiris-postgres osiris-intel
  if ($LASTEXITCODE -ne 0) { throw 'Docker restart failed' }
  WaitIntel
  $after = Invoke-RestMethod "http://localhost:3000/api/ontology/objects/$id/graph?depth=1"
  Require ($after.root_id -eq $id) 'Root lost after restart'
  Require ($after.nodes.Count -eq $second.nodes.Count -and $after.links.Count -eq $second.links.Count) 'Graph changed across restart'
}
[ordered]@{ result='PASS'; root_id=$id; nodes=$second.nodes.Count; links=$second.links.Count; traversal_nodes=$traversal.nodes.Count; traversal_links=$traversal.links.Count; restarted=[bool]$Restart; warnings=$second.warnings } | ConvertTo-Json
