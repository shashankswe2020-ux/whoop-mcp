<#
  Tests MCP_CONNECTOR_PASSWORD directly against the server, with claude.ai
  taken out of the picture. Answers one question: does the deployed server
  accept this password?

  /authorize is rate limited to 3 requests per minute, so run this at most
  once a minute.

  Usage:  .\scripts\verify-connector.ps1 -Password 'abc123...'

  Uses curl.exe rather than Invoke-WebRequest. Windows PowerShell 5.1 parses
  HTML responses with the Internet Explorer engine unless -UseBasicParsing is
  passed, which throws a security prompt and then an exception carrying no
  response object - so a perfectly healthy server looks unreachable.

  ASCII only on purpose - see the note in new-connector-password.ps1.
#>

param(
  [Parameter(Mandatory = $true)][string] $Password,
  [string] $AppUrl = "https://whoop-mcp-enjofaes.fly.dev"
)

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "  curl.exe not found. It ships with Windows 10 1803 and later." -ForegroundColor Red
  Write-Host ""
  exit 1
}

$tmp = [IO.Path]::GetTempFileName()
$status = & curl.exe -s -o $tmp -w "%{http_code}" --max-time 30 -X POST "$AppUrl/authorize" `
  --data-urlencode "connector_password=$Password" `
  --data-urlencode "redirect_uri=https://claude.ai/api/mcp/auth_callback" `
  --data "client_id=whoop-mcp-connector" `
  --data "response_type=code" `
  --data "code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" `
  --data "code_challenge_method=S256"

$content = ""
if (Test-Path $tmp) {
  $content = Get-Content $tmp -Raw -ErrorAction SilentlyContinue
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
$code = 0
[int]::TryParse($status, [ref]$code) | Out-Null

Write-Host ""
if ($code -eq 0) {
  Write-Host "  COULD NOT REACH $AppUrl" -ForegroundColor Red
  Write-Host "  curl returned no status. Check the URL, or the machine may be asleep."
} elseif ($code -eq 401 -and $content -match "Incorrect password") {
  Write-Host "  WRONG PASSWORD" -ForegroundColor Red
  Write-Host "  The server rejected it. What is deployed differs from what you typed."
  Write-Host "  Reset with .\scripts\new-connector-password.ps1, then re-run both workflows."
} elseif ($code -eq 429) {
  Write-Host "  RATE LIMITED" -ForegroundColor Yellow
  Write-Host "  /authorize allows 3 requests a minute and a browser attempt costs 2."
  Write-Host "  This was never a password problem. Wait 60 seconds, then retry the connector."
} elseif ($code -eq 401) {
  Write-Host "  401, but not the password page." -ForegroundColor Yellow
  Write-Host "  Check the app URL is correct."
} else {
  Write-Host "  PASSWORD ACCEPTED (HTTP $code)" -ForegroundColor Green
  Write-Host "  The server took it and moved on to the OAuth step, so the password is"
  Write-Host "  correct and the fault is elsewhere in the claude.ai connector flow."
}
Write-Host ""
