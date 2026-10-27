# Publica una nueva versión: compila, sube el código a GitHub, crea el release con solo el
# instalador y la versión portable, y después publica updates/latest.yml en el repositorio,
# que es lo que leen las copias instaladas para actualizarse.
#
#   .\scripts\release.ps1 -Version 1.5.0 -Notes "Qué cambió"
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

Write-Host "1/6 Versión $Version"
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($current -ne $Version) { Invoke-Checked { npm version $Version --no-git-tag-version | Out-Null } 'npm version' }

Write-Host "2/6 Copiando a $BuildDir"
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

Write-Host '3/6 Compilando instalador'
Push-Location $BuildDir
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
Invoke-Checked { npm run dist } 'electron-builder'
Pop-Location
$dist = "$BuildDir\dist"
$setup = "$dist\Pulso-Setup-$Version.exe"
$portable = "$dist\Pulso-Portable-$Version.exe"
foreach ($a in $setup, $portable, "$dist\latest.yml") { if (-not (Test-Path $a)) { throw "No se generó $a" } }

Write-Host '4/6 Subiendo el código'
Invoke-Checked { git add -A } 'git add'
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Invoke-Checked { git commit -q -m "Versión $Version" } 'git commit' }
Invoke-Checked { git tag -f $Tag } 'git tag'
Invoke-Checked { git push origin HEAD:main } 'git push'
Invoke-Checked { git push -f origin $Tag } 'git push tag'

Write-Host '5/6 Creando el release'
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
# El release solo lleva el instalador y la portable: cualquier otro archivo se borra.
foreach ($old in $release.assets) {
  Invoke-RestMethod -Method Delete "$api/releases/assets/$($old.id)" -Headers $headers | Out-Null
}
$upload = $release.upload_url -replace '\{.*\}', ''
foreach ($file in $setup, $portable) {
  $name = Split-Path $file -Leaf
  Write-Host "  Subiendo $name"
  Invoke-RestMethod -Method Post "$upload`?name=$name" -Headers $headers -InFile $file `
    -ContentType 'application/octet-stream' -TimeoutSec 1800 | Out-Null
}

# Se publica al final, cuando el instalador ya se puede descargar: si no, las copias instaladas
# verían la versión nueva antes de que exista su archivo.
Write-Host '6/6 Publicando el aviso de actualización (updates/latest.yml)'
$setupUrl = "https://github.com/$Owner/$Repo/releases/download/$Tag/Pulso-Setup-$Version.exe"
$yml = (Get-Content "$dist\latest.yml" -Raw) -replace "(?m)^(\s*-?\s*url:\s*).*$", "`${1}$setupUrl" `
  -replace "(?m)^path:\s*.*$", "path: $setupUrl"
New-Item -ItemType Directory -Force "$Root\updates" | Out-Null
[IO.File]::WriteAllText("$Root\updates\latest.yml", $yml)
Invoke-Checked { git add updates/latest.yml } 'git add latest.yml'
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  Invoke-Checked { git commit -q -m "Publicar actualización $Version" } 'git commit latest.yml'
  Invoke-Checked { git push origin HEAD:main } 'git push latest.yml'
}
Write-Host "Listo: $($release.html_url)"
