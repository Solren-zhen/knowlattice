# KnowLattice local static server.
# Zero dependency: runs on the PowerShell that ships with Windows (5.1+).
# Serves the app folder over http://127.0.0.1:<port>/ (loopback only, no LAN exposure).
# ASCII-only source on purpose: Windows PowerShell 5.1 mis-decodes non-BOM script files.
param(
  [string]$Root,
  [int]$Port = 8790,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $PSScriptRoot 'app' }
if (-not (Test-Path -LiteralPath $Root)) {
  Write-Host "App folder not found: $Root" -ForegroundColor Red
  [void](Read-Host 'Press Enter to exit')
  exit 1
}
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $Root 'index.html'))) {
  Write-Host "index.html not found under: $Root" -ForegroundColor Red
  [void](Read-Host 'Press Enter to exit')
  exit 1
}

$Mime = @{
  '.html'        = 'text/html; charset=utf-8'
  '.htm'         = 'text/html; charset=utf-8'
  '.js'          = 'text/javascript; charset=utf-8'
  '.mjs'         = 'text/javascript; charset=utf-8'
  '.css'         = 'text/css; charset=utf-8'
  '.json'        = 'application/json; charset=utf-8'
  '.map'         = 'application/json'
  '.webmanifest' = 'application/manifest+json'
  '.svg'         = 'image/svg+xml'
  '.png'         = 'image/png'
  '.jpg'         = 'image/jpeg'
  '.jpeg'        = 'image/jpeg'
  '.gif'         = 'image/gif'
  '.webp'        = 'image/webp'
  '.ico'         = 'image/x-icon'
  '.bmp'         = 'image/bmp'
  '.wasm'        = 'application/wasm'
  '.woff'        = 'font/woff'
  '.woff2'       = 'font/woff2'
  '.ttf'         = 'font/ttf'
  '.otf'         = 'font/otf'
  '.pdf'         = 'application/pdf'
  '.txt'         = 'text/plain; charset=utf-8'
  '.gz'          = 'application/gzip'
  '.docx'        = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

function Send-Body($stream, [string]$status, [string]$ctype, [byte[]]$bytes) {
  $head = "HTTP/1.1 $status`r`nContent-Type: $ctype`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($bytes.Length -gt 0) { $stream.Write($bytes, 0, $bytes.Length) }
  $stream.Flush()
}
function Send-Text($stream, [string]$status, [string]$text) {
  Send-Body $stream $status 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes($text))
}

$listener = $null
for ($p = $Port; $p -lt ($Port + 40); $p++) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $l.Start()
    $listener = $l
    $Port = $p
    break
  } catch { }
}
if (-not $listener) {
  Write-Host 'No free port available (tried 40 ports).' -ForegroundColor Red
  [void](Read-Host 'Press Enter to exit')
  exit 1
}

$url = "http://127.0.0.1:$Port/"
Write-Host ''
Write-Host "  KnowLattice is running at  $url" -ForegroundColor Green
Write-Host '  Keep this window open while using the app.' -ForegroundColor DarkGray
Write-Host '  Close this window to stop the server.' -ForegroundColor DarkGray
Write-Host ''
if (-not $NoBrowser) {
  try { Start-Process $url } catch { }
}

$rootPrefix = $Root + '\'
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 5000
    $stream.WriteTimeout = 20000
    $buf = New-Object byte[] 16384
    $sb = New-Object System.Text.StringBuilder
    while (-not $sb.ToString().Contains("`r`n`r`n")) {
      try { $n = $stream.Read($buf, 0, $buf.Length) } catch { $n = 0 }
      if ($n -le 0) { break }
      [void]$sb.Append([Text.Encoding]::ASCII.GetString($buf, 0, $n))
      if ($sb.Length -gt 65536) { break }
    }
    $req = $sb.ToString()
    if (-not $req) { continue }

    $line = ($req -split "`r`n")[0]
    $sp = $line.IndexOf(' ')
    if ($sp -lt 1) { Send-Text $stream '400 Bad Request' 'bad request'; continue }
    $method = $line.Substring(0, $sp)
    $target = ($line.Substring($sp + 1) -split ' ')[0]
    $path = ($target -split '\?')[0]
    try { $path = [Uri]::UnescapeDataString($path) } catch { }
    if ([string]::IsNullOrEmpty($path) -or $path -eq '/') { $path = '/index.html' }

    $rel = ($path.TrimStart('/') -replace '/', '\')
    $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
    if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      Send-Text $stream '403 Forbidden' 'forbidden'; continue
    }
    if (Test-Path -LiteralPath $full -PathType Container) { $full = Join-Path $full 'index.html' }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      # SPA fallback: extension-less paths fall back to index.html
      if ($path -notmatch '\.[A-Za-z0-9]+$') { $full = Join-Path $Root 'index.html' }
      else { Send-Text $stream '404 Not Found' "not found: $path"; continue }
    }

    $bytes = [IO.File]::ReadAllBytes($full)
    $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
    $ctype = $Mime[$ext]
    if (-not $ctype) { $ctype = 'application/octet-stream' }
    Send-Body $stream '200 OK' $ctype $bytes
  } catch {
  } finally {
    try { $client.Close() } catch { }
  }
}
