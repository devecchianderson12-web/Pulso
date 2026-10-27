# Publica una nueva versión: compila, sube el código a GitHub y crea el release
# con los archivos que usa el actualizador automático.
#
#   .\scripts\release.ps1 -Version 1.2.0 -Notes "Qué cambió"
#
# Usa la credencial de GitHub que Git ya tiene guardada en este equipo.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = '',
  # NSIS falla con rutas de más de 260 caracteres, así que se compila en una carpeta corta.
  [string]$BuildDir = "$env:USERPROFILE\wdsrc\build"
)
$ErrorActionPreference = 'Stop'
$Owner = 'devecchianderson12-web'
$Repo = 'Pulso'
$Root = Split-Path -Parent $PSScriptRoot
$Tag = "v$Version"

function Invoke-Checked([scriptblock]$Block, [string]$What) {
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "Falló: $What" }
}

Set-Location $Root
if (git status --porcelain -- package.json package-lock.json) {
  Write-Host 'Aviso: package.json tiene cambios sin guardar; se incluirán en esta versión.'
}

Write-Host "1/5 Versión $Version"
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($current -ne $Version) { Invoke-Checked { npm version $Version --no-git-tag-version | Out-Null } 'npm version' }

Write-Host "2/5 Copiando a $BuildDir"
New-Item -ItemType Directory -Force $BuildDir | Out-Null
robocopy $Root $BuildDir /MIR /XD node_modules dist .git /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Falló la copia a la carpeta de compilación' }
$lockHash = (Get-FileHash "$BuildDir\package-lock.json").Hash
$stamp = "$BuildDir\node_modules\.lock-hash"
if (-not (Test-Path $stamp) -or (Get-Content $stamp) -ne $lockHash) {
  Push-Location $BuildDir
  Invoke-Checked { npm ci --no-audit --no-fund } 'npm ci'
  Pop-Location
  Set-Content $stamp $lockHash
}

Write-Host '3/5 Compilando instalador'
Push-Location $BuildDir
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
Invoke-Checked { npm run dist } 'electron-builder'
Pop-Location
$dist = "$BuildDir\dist"
$assets = @(
  "$dist\Pulso-Setup-$Version.exe",
  "$dist\Pulso-Setup-$Version.exe.blockmap",
  "$dist\latest.yml",
  "$dist\Pulso-Portable-$Version.exe"
)
foreach ($a in $assets) { if (-not (Test-Path $a)) { throw "No se generó $a" } }

Write-Host '4/5 Subiendo el código'
Invoke-Checked { git add -A } 'git add'
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Invoke-Checked { git commit -q -m "Versión $Version" } 'git commit' }
Invoke-Checked { git tag -f $Tag } 'git tag'
Invoke-Checked { git push origin HEAD:main } 'git push'
Invoke-Checked { git push -f origin $Tag } 'git push tag'

Write-Host '5/5 Creando el release'
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
$token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw 'No hay credencial de GitHub guardada en Git' }
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$api = "https://api.github.com/repos/$Owner/$Repo"
if (-not $Notes) { $Notes = "Pulso $Version" }
$body = @{
  tag_name = $Tag; name = "Pulso $Version"; target_commitish = 'main'
  body = "$Notes`n`n**Descargas:** ``Pulso-Setup-$Version.exe`` (instalador, se actualiza solo) o ``Pulso-Portable-$Version.exe`` (portable)."
} | ConvertTo-Json
try {
  $release = Invoke-RestMethod "$api/releases/tags/$Tag" -Headers $headers
  Write-Host "  El release $Tag ya existe; se reemplazan sus archivos."
} catch {
  $release = Invoke-RestMethod -Method Post "$api/releases" -Headers $headers `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8'
}
$upload = $release.upload_url -replace '\{.*\}', ''
foreach ($file in $assets) {
  $name = Split-Path $file -Leaf
  $old = $release.assets | Where-Object name -eq $name
  if ($old) { Invoke-RestMethod -Method Delete "$api/releases/assets/$($old.id)" -Headers $headers | Out-Null }
  Write-Host "  Subiendo $name"
  Invoke-RestMethod -Method Post "$upload`?name=$name" -Headers $headers -InFile $file `
    -ContentType 'application/octet-stream' -TimeoutSec 1800 | Out-Null
}
Write-Host "Listo: $($release.html_url)"
