$workers = @(
  "worker:pr-poll",
  "worker:pms-sync",
  "worker:rework",
  "worker:integration",
  "worker:code-review",
  "worker:reanalysis",
  "worker:daily-scheduler",
  "worker:deploy"
)

$dir = $PSScriptRoot

foreach ($w in $workers) {
  $title = $w -replace "worker:", ""
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$dir'; npm run $w" -WindowStyle Normal
  Write-Host "Started: $w"
  Start-Sleep -Milliseconds 500
}

Write-Host "`nAll remaining workers launched." -ForegroundColor Green
