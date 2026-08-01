param(
    [string]$Image = "infinite-canvas:auth-smoke",
    [switch]$SkipBuild,
    [switch]$RuntimeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$containers = [System.Collections.Generic.List[string]]::new()
$passwordFile = $null
$username = "smoke.user"
$password = 'Smoke password $ " \ 2026'
$originalAuthUsername = [Environment]::GetEnvironmentVariable("AUTH_USERNAME", "Process")
$originalAuthPassword = [Environment]::GetEnvironmentVariable("AUTH_PASSWORD", "Process")

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-Docker {
    param([string[]]$DockerArguments)
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& docker @DockerArguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "docker $($DockerArguments -join ' ') failed:`n$($output -join [Environment]::NewLine)"
    }
    return $output
}

function New-ContainerName {
    param([string]$Suffix)
    return "infinite-canvas-auth-$Suffix-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
}

function Assert-StartupFails {
    param([string]$Label, [string[]]$DockerArguments, [string]$ExpectedMessage)
    $name = New-ContainerName $Label
    $containers.Add($name)
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& docker run --name $name @DockerArguments $Image 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    Assert-True ($exitCode -ne 0) "$Label unexpectedly started"
    Assert-True (($output -join "`n") -match [regex]::Escape($ExpectedMessage)) "$Label did not report the expected validation error"
    Write-Host "PASS startup rejected: $Label"
}

function Start-SmokeContainer {
    param([string]$Label, [string[]]$DockerArguments)
    $name = New-ContainerName $Label
    $containers.Add($name)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $hostPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    Invoke-Docker (@("run", "-d", "--name", $name, "--publish", "127.0.0.1:${hostPort}:3000") + $DockerArguments + @($Image)) | Out-Null

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $baseUrl = "http://127.0.0.1:$hostPort"
        try {
            $response = Invoke-HttpGet "$baseUrl/"
            if ($response.Status -gt 0) { return @{ Name = $name; BaseUrl = $baseUrl } }
        } catch {}
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Label did not become ready within 30 seconds"
}

function Invoke-HttpGet {
    param([string]$Url, [string]$Username = "", [string]$Password = "", [hashtable]$RequestHeaders = @{})
    $client = [System.Net.Http.HttpClient]::new()
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
    try {
        if ($Username) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("${Username}:${Password}")
            $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Basic", [Convert]::ToBase64String($bytes))
        }
        foreach ($header in $RequestHeaders.GetEnumerator()) {
            $request.Headers.TryAddWithoutValidation([string]$header.Key, [string]$header.Value) | Out-Null
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $headers = @{}
        foreach ($header in $response.Headers) { $headers[$header.Key] = $header.Value -join ", " }
        foreach ($header in $response.Content.Headers) { $headers[$header.Key] = $header.Value -join ", " }
        return @{ Status = [int]$response.StatusCode; Body = $body; Headers = $headers }
    } finally {
        $request.Dispose()
        $client.Dispose()
    }
}

try {
    Push-Location $repoRoot
    if (-not $SkipBuild) {
        Write-Host "Building $Image"
        $buildArguments = @("build", "--tag", $Image)
        if ($RuntimeOnly) { $buildArguments += @("--file", "scripts/Dockerfile.auth-smoke") }
        Invoke-Docker ($buildArguments + @(".")) | Write-Host
    }

    Assert-StartupFails "missing-credentials" @() "AUTH_USERNAME is required"
    $env:AUTH_USERNAME = "bad:name"
    $env:AUTH_PASSWORD = $password
    Assert-StartupFails "invalid-username" @("-e", "AUTH_USERNAME", "-e", "AUTH_PASSWORD") "AUTH_USERNAME must be"
    $env:AUTH_USERNAME = $username
    $env:AUTH_PASSWORD = "too-short"
    Assert-StartupFails "short-password" @("-e", "AUTH_USERNAME", "-e", "AUTH_PASSWORD") "at least 12 bytes"
    Assert-StartupFails "unguarded-disabled" @("-e", "AUTH_MODE=disabled") "AUTH_ALLOW_INSECURE_LOOPBACK=1"

    $env:AUTH_PASSWORD = $password
    $required = Start-SmokeContainer "required" @("-e", "AUTH_USERNAME", "-e", "AUTH_PASSWORD")
    $anonymous = Invoke-HttpGet "$($required.BaseUrl)/"
    Assert-True ($anonymous.Status -eq 401) "anonymous root request should return 401"
    Assert-True ($anonymous.Headers["WWW-Authenticate"] -match "Basic") "401 response should request Basic authentication"
    Assert-True ($anonymous.Headers["Cache-Control"] -match "no-store") "401 responses should disable caching"
    Assert-True ((Invoke-HttpGet "$($required.BaseUrl)/config.js").Status -eq 401) "config.js should be protected"
    Assert-True ((Invoke-HttpGet "$($required.BaseUrl)/" $username "wrong-password").Status -eq 401) "wrong password should return 401"

    $root = Invoke-HttpGet "$($required.BaseUrl)/" $username $password
    Assert-True ($root.Status -eq 200 -and $root.Body -match "<!doctype html") "valid credentials should load the app"
    Assert-True ($root.Headers["Cache-Control"] -match "no-store") "responses should disable caching"
    Assert-True ($root.Headers["X-Content-Type-Options"] -eq "nosniff") "nosniff header is missing"
    Assert-True ($root.Headers["Referrer-Policy"] -eq "no-referrer") "referrer policy is missing"
    $contentSecurityPolicy = $root.Headers["Content-Security-Policy"]
    Assert-True ($contentSecurityPolicy -match "script-src 'self'") "CSP must restrict scripts to same-origin assets"
    Assert-True (-not ($contentSecurityPolicy -match "unsafe-eval")) "CSP must not allow unsafe-eval"
    Assert-True ($root.Headers["Strict-Transport-Security"] -match "max-age=31536000") "HSTS header is missing"
    Assert-True ((Invoke-HttpGet "$($required.BaseUrl)/canvas/auth-smoke" $username $password).Status -eq 200) "authenticated SPA deep link should load"
    $runtimeConfig = Invoke-HttpGet "$($required.BaseUrl)/config.js" $username $password
    Assert-True (-not $runtimeConfig.Body.Contains($password)) "runtime config leaked the authentication password"
    Invoke-HttpGet "$($required.BaseUrl)/?apiKey=do-not-log-smoke-secret" $username $password @{ Referer = "https://example.test/?token=do-not-log-referer-secret" } | Out-Null

    $hash = @(Invoke-Docker @("exec", $required.Name, "cut", "-d:", "-f2", "/etc/nginx/infinite-canvas/.htpasswd")) -join ""
    Assert-True ($hash -match '^\$2[aby]\$12\$') "credential file should contain a bcrypt cost-12 hash"
    $credentialPermissions = @(Invoke-Docker @("exec", $required.Name, "stat", "-c", "%a:%U:%G", "/etc/nginx/infinite-canvas/.htpasswd")) -join ""
    Assert-True ($credentialPermissions -eq "640:root:nginx") "credential file should be mode 640 and owned by root:nginx"
    $pidOneEnvironment = @(Invoke-Docker @("exec", $required.Name, "sh", "-c", "tr '\0' '\n' < /proc/1/environ")) -join "`n"
    Assert-True (-not ($pidOneEnvironment -match '(^|\n)AUTH_PASSWORD=')) "nginx process environment retained the cleartext password"
    $logs = @(Invoke-Docker @("logs", $required.Name)) -join "`n"
    Assert-True (-not $logs.Contains($password)) "container logs leaked the authentication password"
    Assert-True (-not $logs.Contains("do-not-log-smoke-secret")) "access logs leaked a query-string secret"
    Assert-True (-not $logs.Contains("do-not-log-referer-secret")) "access logs leaked a referrer secret"
    Write-Host "PASS required mode: 401/401/200, protected config, deep link, bcrypt and headers"

    $passwordFile = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($passwordFile, "$password`n", [Text.UTF8Encoding]::new($false))
    $fileMode = Start-SmokeContainer "password-file" @(
        "--mount", "type=bind,source=$passwordFile,target=/run/secrets/infinite-canvas-password,readonly",
        "-e", "AUTH_USERNAME=$username",
        "-e", "AUTH_PASSWORD_FILE=/run/secrets/infinite-canvas-password"
    )
    Assert-True ((Invoke-HttpGet "$($fileMode.BaseUrl)/" $username $password).Status -eq 200) "AUTH_PASSWORD_FILE credentials should work"
    Write-Host "PASS password file mode"

    $compose = (Invoke-Docker @("compose", "-f", "docker-compose.local.yml", "config", "--format", "json") | Out-String) | ConvertFrom-Json
    $localPort = @($compose.services.app.ports)[0]
    Assert-True ($localPort.host_ip -eq "127.0.0.1") "local disabled compose must bind only to 127.0.0.1"
    Assert-True ($compose.services.app.environment.AUTH_MODE -eq "disabled") "local compose should explicitly disable authentication"
    Assert-True ($compose.services.app.environment.AUTH_ALLOW_INSECURE_LOOPBACK -eq "1") "local compose should explicitly acknowledge loopback-only insecure mode"

    $productionCompose = (Invoke-Docker @("compose", "-f", "docker-compose.yml", "config", "--format", "json") | Out-String) | ConvertFrom-Json
    $productionPort = @($productionCompose.services.app.ports)[0]
    Assert-True ($productionPort.host_ip -eq "127.0.0.1") "production compose must bind to loopback by default"
    Assert-True ($productionCompose.services.app.image -eq "ghcr.io/clqx/infinite-canvas:latest") "production compose must use the fork image by default"

    $disabled = Start-SmokeContainer "disabled" @("-e", "AUTH_MODE=disabled", "-e", "AUTH_ALLOW_INSECURE_LOOPBACK=1")
    Assert-True ((Invoke-HttpGet "$($disabled.BaseUrl)/").Status -eq 200) "guarded loopback-only disabled mode should load without credentials"
    Write-Host "PASS disabled mode is guarded and local compose is loopback-only"
    Write-Host "All authentication container smoke tests passed."
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    foreach ($container in $containers) {
        & docker rm --force $container 2>&1 | Out-Null
    }
    $ErrorActionPreference = $previousErrorAction
    if ($passwordFile -and (Test-Path -LiteralPath $passwordFile)) {
        Remove-Item -LiteralPath $passwordFile -Force
    }
    [Environment]::SetEnvironmentVariable("AUTH_USERNAME", $originalAuthUsername, "Process")
    [Environment]::SetEnvironmentVariable("AUTH_PASSWORD", $originalAuthPassword, "Process")
}
