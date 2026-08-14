param(
  [Parameter(Mandatory = $true)]
  [string] $SearchRoot
)

$ErrorActionPreference = "Stop"

$installers = @(
  Get-ChildItem -LiteralPath $SearchRoot -Filter "*.exe" -File -Recurse |
    Where-Object { $_.FullName -match "[\\/]bundle[\\/]nsis[\\/]" } |
    Sort-Object FullName
)

if ($installers.Count -eq 0) {
  throw "No NSIS installer was found under $SearchRoot"
}

foreach ($installer in $installers) {
  $hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumPath = "$($installer.FullName).sha256"
  [System.IO.File]::WriteAllText(
    $checksumPath,
    "$hash  $($installer.Name)`n",
    [System.Text.Encoding]::ASCII
  )
  Write-Output "Wrote $checksumPath"
}
