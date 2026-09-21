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
  '.md'          = 'text/plain; charset=utf-8'
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

# --- Port / origin policy -------------------------------------------------
# Browsers keep IndexedDB and localStorage per origin, and the origin includes
# the port. So http://127.0.0.1:8790 and http://127.0.0.1:8791 are two
# different sites holding two different vaults. Hence:
#   1. if a KnowLattice is already answering anywhere in the port range, open
#      it instead of starting a second server (that copy holds the notes);
#   2. if we are forced onto another port, say so loudly.
function Test-KnowLattice([int]$p) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect([System.Net.IPAddress]::Loopback, $p)
    $stream = $client.GetStream()
    $stream.ReadTimeout = 2000
    $req = [Text.Encoding]::ASCII.GetBytes("GET /index.html HTTP/1.0`r`nHost: 127.0.0.1`r`nConnection: close`r`n`r`n")
    $stream.Write($req, 0, $req.Length)
    $stream.Flush()
    $buf = New-Object byte[] 8192
    $text = ''
    for ($i = 0; $i -lt 4; $i++) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $text += [Text.Encoding]::UTF8.GetString($buf, 0, $n)
      if ($text.Contains('KnowLattice')) { break }
    }
    return ($text.Contains('200 OK') -and $text.Contains('KnowLattice'))
  } catch {
    return $false
  } finally {
    if ($client) { try { $client.Close() } catch { } }
  }
}

$running = 0
# Which ports in our range already have a listener? One instant query beats
# connecting to 40 closed ports, which costs ~2s each on Windows.
$busy = @()
try {
  $busy = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalPort -ge $Port -and $_.LocalPort -lt ($Port + 40) } |
    Select-Object -ExpandProperty LocalPort -Unique | Sort-Object)
} catch {
  # NetTCPIP missing (pre-Windows 8): at least check the preferred port.
  $busy = @($Port)
}
foreach ($p in $busy) {
  if (Test-KnowLattice $p) { $running = $p; break }
}
if ($running -gt 0) {
  $url = "http://127.0.0.1:$running/"
  Write-Host ''
  Write-Host "  KnowLattice is already running at  $url" -ForegroundColor Green
  Write-Host '  Opening that copy: notes are stored per address, so that is where' -ForegroundColor DarkGray
  Write-Host '  your notes are. (Just unpacked a newer version? Close that window,' -ForegroundColor DarkGray
  Write-Host '  then start again to run the new one.)' -ForegroundColor DarkGray
  Write-Host ''
  if (-not $NoBrowser) {
    try { Start-Process $url } catch { }
  }
  exit 0
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
if ($Port -ne 8790) {
  Write-Host ''
  Write-Host "  WARNING: port 8790 is taken by another program; using $Port." -ForegroundColor Yellow
  Write-Host '  Notes are stored per address, so this address starts with its own empty vault:' -ForegroundColor Yellow
  Write-Host "    http://127.0.0.1:$Port/   is NOT the same site as   http://127.0.0.1:8790/" -ForegroundColor Yellow
  Write-Host '  Close whatever holds 8790 and start again to get your notes back.' -ForegroundColor Yellow
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
# Safety net for anything that still gets through: without it the window vanishes and the
# browser tab just says "Failed to fetch" with no explanation. Start-KnowLattice.bat runs
# `if errorlevel 1 pause`, so exiting non-zero keeps this message on screen.
trap {
  Write-Host ''
  Write-Host ("  Server stopped: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host '  The page already open in your browser can no longer load anything;' -ForegroundColor Yellow
  Write-Host '  it will report "Failed to fetch". Close that tab, then start' -ForegroundColor Yellow
  Write-Host '  Start-KnowLattice.bat again. Your notes are still there.' -ForegroundColor Yellow
  Write-Host ''
  [void](Read-Host 'Press Enter to exit')
  exit 1
}
while ($true) {
  # AcceptTcpClient() must be guarded: browsers abort connections routinely (cancelled
  # preconnect, page navigation, aborted lazy-chunk fetch) and on Windows that surfaces here
  # as a SocketException. With $ErrorActionPreference = 'Stop' a single one of those used to
  # terminate the whole script - the window disappears, and from then on every request in the
  # already-open browser tab fails with "Failed to fetch" for no visible reason.
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
  } catch {
    Write-Host ("  [warn] accept failed, still serving: " + $_.Exception.Message) -ForegroundColor DarkYellow
    Start-Sleep -Milliseconds 50
    continue
  }
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
    # Files like LICENSE / COPYING have no extension; serve them as plain text
    # instead of letting the browser download them.
    if (-not $ctype -and [IO.Path]::GetFileNameWithoutExtension($full) -match '^(LICENSE|COPYING|NOTICE|README)$') {
      $ctype = 'text/plain; charset=utf-8'
    }
    if (-not $ctype) { $ctype = 'application/octet-stream' }
    Send-Body $stream '200 OK' $ctype $bytes
  } catch {
  } finally {
    try { $client.Close() } catch { }
  }
}
