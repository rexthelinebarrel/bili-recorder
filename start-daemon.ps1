Set-Location $PSScriptRoot
while ($true) {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting bili-recorder..."
    $proc = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru
    $proc.WaitForExit()
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Server stopped (exit $($proc.ExitCode)). Restarting in 3s..."
    Start-Sleep -Seconds 3
}
