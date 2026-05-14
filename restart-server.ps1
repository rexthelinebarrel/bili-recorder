$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Try graceful shutdown first (lets ffmpeg finalize MP4 files)
try {
    Invoke-WebRequest -Uri "http://localhost:3456/api/shutdown" -Method POST -TimeoutSec 5 | Out-Null
    Write-Host "Sent graceful shutdown request..."
    Start-Sleep -Seconds 6
} catch {
    # Server might not be running, that's OK
}

# Kill any remaining node server.js processes
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server.js*" }
foreach ($p in $procs) {
    Write-Host "Killing node process PID $($p.ProcessId)..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# Start new server in background
Write-Host "Starting bili-recorder..."
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
Write-Host "Server restarted."
