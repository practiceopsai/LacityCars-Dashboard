param(
    [string]$HermesHome = 'C:\Users\Administrator\AppData\Local\hermes',
    [string]$RagRoot = 'C:\Users\Administrator\Desktop\LaCity\Lacity Cars',
    [string]$CallbackOrigin = 'https://lacity-api-production.up.railway.app',
    [string]$PromptFile = "$PSScriptRoot\vehicle-ready-prompt.txt",
    [string]$CallbackHelper = "$PSScriptRoot\dashboard_callback.py",
    [string]$RdpFocusHelper = "$PSScriptRoot\focus_autosoft_rdp.py"
)

$ErrorActionPreference = 'Stop'
$hermes = Join-Path $HermesHome 'hermes-agent\bin\hermes.exe'
$config = Join-Path $HermesHome 'config.yaml'
$envFile = Join-Path $HermesHome '.env'

foreach ($required in $hermes, $config, $envFile, $RagRoot, $PromptFile, $CallbackHelper, $RdpFocusHelper) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required path missing: $required" }
}

function New-HexSecret([int]$ByteCount = 32) {
    $bytes = New-Object byte[] $ByteCount
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-ConfigValue([string]$Key) {
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $value = & $hermes config get $Key 2>$null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    if ($exitCode -eq 0) { return ($value | Out-String).Trim() }
    return ''
}

function Set-ConfigValue([string]$Key, [string]$Value) {
    & $hermes config set --force $Key $Value | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to set Hermes config key: $Key" }
}

function Set-DotEnvValue([string]$Name, [string]$Value) {
    $lines = @(Get-Content -LiteralPath $envFile)
    $prefix = "$Name="
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].StartsWith($prefix, [StringComparison]::Ordinal)) {
            $lines[$i] = "$prefix$Value"
            $found = $true
        }
    }
    if (-not $found) { $lines += "$prefix$Value" }
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
}

function Append-Once([string]$Path, [string]$Marker, [string]$Block) {
    $text = [IO.File]::ReadAllText($Path)
    if (-not $text.Contains($Marker)) {
        [IO.File]::WriteAllText(
            $Path,
            $text.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $Block.Trim() + [Environment]::NewLine,
            (New-Object Text.UTF8Encoding($false))
        )
    }
}

function Upsert-MarkedSection([string]$Path, [string]$Marker, [string]$Block) {
    $text = [IO.File]::ReadAllText($Path)
    $escaped = [Regex]::Escape($Marker)
    $pattern = "(?ms)^$escaped\r?\n.*?(?=^## |\z)"
    $replacement = $Block.Trim() + [Environment]::NewLine + [Environment]::NewLine
    if ([Regex]::IsMatch($text, $pattern)) {
        $text = [Regex]::Replace($text, $pattern, $replacement, 1)
    } else {
        $text = $text.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $replacement
    }
    [IO.File]::WriteAllText($Path, $text.TrimEnd() + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $config -Destination "$config.bak.dashboard-webhook.$timestamp" -Force

$triggerSecret = Get-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.secret'
if ($triggerSecret.Length -lt 32) { $triggerSecret = New-HexSecret }
$callbackSecret = Get-ConfigValue 'LACITY_DASHBOARD_CALLBACK_SECRET'
if ($callbackSecret.Length -lt 16) { $callbackSecret = New-HexSecret }
$prompt = Get-Content -Raw -LiteralPath $PromptFile

Set-ConfigValue 'platforms.webhook.enabled' 'true'
Set-ConfigValue 'platforms.webhook.extra.host' '127.0.0.1'
Set-ConfigValue 'platforms.webhook.extra.port' '8644'
Set-ConfigValue 'platforms.webhook.extra.rate_limit' '5'
Set-ConfigValue 'platforms.webhook.extra.max_body_bytes' '65536'
Set-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.enabled' 'true'
Set-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.events' '["vehicle.ready","vehicle.batch_ready"]'
Set-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.secret' $triggerSecret
Set-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.prompt' $prompt
Set-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.skills' '["vehicle-stock-in"]'
# Generic webhook routes are intentionally sandboxed by Hermes. This route is
# loopback-only, HMAC-authenticated, and dedicated to an authorized stocking
# job, so grant only the tools needed by the documented workflow.
Set-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.toolsets' '["terminal","file","browser","computer_use","vision","skills","todo","memory"]'
Set-ConfigValue 'platforms.webhook.extra.routes.vehicle-stocking.deliver' 'log'
Set-ConfigValue 'LACITY_DASHBOARD_CALLBACK_SECRET' $callbackSecret
Set-DotEnvValue 'LACITY_DASHBOARD_CALLBACK_ORIGIN' $CallbackOrigin

$toolsDir = Join-Path $RagRoot 'tools'
New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
Copy-Item -LiteralPath $CallbackHelper -Destination (Join-Path $toolsDir 'dashboard_callback.py') -Force
Copy-Item -LiteralPath $RdpFocusHelper -Destination (Join-Path $toolsDir 'focus_autosoft_rdp.py') -Force

$contractBlock = @'
## Dashboard-triggered stocking runs

- A valid `vehicle.ready` event on the HMAC-authenticated `vehicle-stocking` webhook is explicit authorization to stock and post exactly the supplied vehicle for exactly the supplied store. It has the same live authority as an explicit stock-and-post message from the paired operator; do not request duplicate confirmation.
- Process only one dashboard vehicle in the webhook session. Treat `request_id` as the immutable run identity and never substitute a different VIN or store.
- Before a contiguous live-input phase inside Remote Desktop, run `python tools/focus_autosoft_rdp.py --expected-title <payload store.rdp_window_title>`, require `ok: true`, then capture once and visually verify the inner AutoSoft screen shows `<payload store.autosoft_instance>`. Keep that HWND foreground across the batch; re-run the guard only after an actual window/focus change or unexplained state. Never send background input to `mstsc.exe`. An `unverifiable` action requires one fresh visual capture before more input, not repeated blind clicking.
- Use `tools/dashboard_callback.py` to send `PROCESSING` when live work begins and exactly one terminal `COMPLETED` or `FAILED` result after the mandatory RAG finish step. The helper reads its signing secret from the environment; never reveal, print, copy, or place that secret in an artifact.
- The callback's `stock_number`, ACV, freight, final total, source/run summary, and RAG commit must come from verified run evidence. Any safety gate that blocks posting must be returned as `FAILED` with the exact reason.
'@

$scheduleBlock = @'
## Scheduled stocking boundary

- Every dashboard `vehicle.ready` payload includes `schedule.starts_at` as an ISO 8601 instant plus Eastern and Pacific display labels. The UTC instant is authoritative; the labels are operator-readable context.
- `schedule.starts_at` is a hard not-before boundary for all live stocking work because AutoSoft is shared. Independently compare the current time with it before opening or changing the stock sheet, NextGear, AutoSoft, or another live stocking system.
- If a trigger arrives early, fail closed: make no live-system changes and report the premature trigger. Never wait inside or hold open the shared AutoSoft session until the scheduled time.
- A scheduled time does not permit concurrency. Continue to process one dashboard vehicle at a time, and let later scheduled vehicles remain queued while another run owns the desktop.
- Store scheduling instants in UTC and show both America/New_York (Eastern) and America/Los_Angeles (Pacific), using their date-specific daylight-saving abbreviations.
'@

$batchBlock = @'
## Dashboard store-batch runs

- A `vehicle.batch_ready` event is one store-specific execution batch. Never combine stores or switch AutoSoft instances inside the run.
- Before touching a live system, parse the complete ordered manifest. Its array length must equal `batch.vehicle_count`; every child needs a complete request ID and a 17-character VIN. A missing/truncated child is a batch-wide failure: make no live changes and report one child FAILED with `--failure-scope BATCH`.
- Preflight every supplied vehicle first. Accept complete dashboard freight evidence without reopening dispatch. Use one current NextGear export for the whole window, opening detail only for missing/conflicting fields. Scan all VINs from one stock-sheet export. For each contiguous set of authorized columns in the store map, build one tab/newline-delimited clipboard block and paste all new rows at once; split around unauthorized, trade, or formula columns and never step through cells with Tab/Enter. Verify every written row from one independent export before opening AutoSoft.
- Deduplicate each VIN against the dashboard ledger, the named store sheet, and RAG checkpoints. Reuse a verified existing sheet row; never append it again. Never repost a vehicle with a terminal AutoSoft/readback checkpoint.
- Acquire a foreground RDP lease with `python tools/focus_autosoft_rdp.py --expected-title "<payload store.rdp_window_title>"` once before AutoSoft. Continue only when it returns `ok: true`, capture the fresh screen, and visually prove the inner instance is `<payload store.autosoft_instance>`. Keep that verified HWND foreground across vehicles; re-run only after an actual focus/window change or unexplained screen. Never send background input to `mstsc.exe`, and never type after an `unverifiable` action until one fresh capture proves state.
- Build one verified local posting manifest during preflight. Do not revisit the sheet, dispatch workbook, or browser between AutoSoft records unless a verification fails. Keep one foreground AutoSoft session and reuse the open Accounting/Inventory workflow while processing the ordered vehicles sequentially.
- For every text control, focus the visibly verified target, press Ctrl+A, and paste the exact current-vehicle manifest value, then visually/readback verify it. Create a fresh record and completely clear/verify/re-enter only the current VIN for every vehicle. Never paste a multi-vehicle block into AutoSoft. Store charge values may come from the verified store template; VIN, ACV, freight, mileage, title, color, source, and totals remain vehicle-specific.
- On the LA City home screen only, `CRITICAL ERROR ID 227, Position Error #7-0 in AAJ3` is a known one-dismiss startup alert. Click OK once, require the normal `LA City Cars` home, open Accounting, and continue only if its password/PIN prompt appears and accepts the configured saved credential. Treat recurrence inside posting, an unusable Accounting module, or rejected authentication as a batch-wide AutoSoft failure. Never generalize this recovery to another error.
- If Accounting reports an `Incomplete Direct Posting Entry`, dismiss once and inspect the recovery list without choosing `Finish Posting`. Record operator/date/stock/VIN suffix. Do not finish, delete, or overwrite an unrelated or collision-rejected draft; it requires separately authorized AutoSoft correction access or support. Continue only after a clean re-login proves the incomplete entry is resolved; otherwise fail the batch with the exact blocker.
- Send per-vehicle callbacks using each child `request_id`. Checkpoint RAG after every vehicle so a resumed batch cannot repost completed work.
- Isolate vehicle-specific failures and continue. For a store-wide safety failure, stop immediately and send one current-child FAILED callback with `--failure-scope BATCH`; the dashboard deterministically fails and releases all claimed siblings. Do not repeatedly attempt blind recovery.
- Do not use full-screen captures as a polling loop. Capture on screen transitions and verification checkpoints, prefer compact terminal/readback evidence, stop after two identical tool failures, and fail closed when shared preflight exceeds 12 minutes or a vehicle exceeds 15 minutes without a verified checkpoint.
'@

Upsert-MarkedSection (Join-Path $RagRoot '.hermes.md') '## Dashboard-triggered stocking runs' $contractBlock
Upsert-MarkedSection (Join-Path $HermesHome 'skills\operations\vehicle-stock-in\SKILL.md') '## Dashboard-triggered stocking runs' $contractBlock
Upsert-MarkedSection (Join-Path $RagRoot '.hermes.md') '## Scheduled stocking boundary' $scheduleBlock
Upsert-MarkedSection (Join-Path $HermesHome 'skills\operations\vehicle-stock-in\SKILL.md') '## Scheduled stocking boundary' $scheduleBlock
Upsert-MarkedSection (Join-Path $RagRoot '.hermes.md') '## Dashboard store-batch runs' $batchBlock
Upsert-MarkedSection (Join-Path $HermesHome 'skills\operations\vehicle-stock-in\SKILL.md') '## Dashboard store-batch runs' $batchBlock
$profileSkill = Join-Path $HermesHome 'profiles\vehiclestocking\skills\operations\vehicle-stock-in\SKILL.md'
if (Test-Path -LiteralPath $profileSkill) {
    Upsert-MarkedSection $profileSkill '## Dashboard-triggered stocking runs' $contractBlock
    Upsert-MarkedSection $profileSkill '## Scheduled stocking boundary' $scheduleBlock
    Upsert-MarkedSection $profileSkill '## Dashboard store-batch runs' $batchBlock
}

& $hermes config check | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Hermes configuration check failed' }

# Photon launches a bundled Node sidecar. Native Windows gateway restarts do
# not always inherit the user's refreshed PATH, so make both the persistent
# user PATH and this restart process explicit before restarting Hermes.
$nodeDir = Join-Path $HermesHome 'node'
if (Test-Path -LiteralPath $nodeDir) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathParts = @($userPath -split ';' | Where-Object { $_ })
    if ($pathParts -notcontains $nodeDir) {
        [Environment]::SetEnvironmentVariable('Path', (($nodeDir) + ';' + $userPath).TrimEnd(';'), 'User')
    }
    if (@($env:Path -split ';') -notcontains $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
}
& $hermes gateway restart | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Hermes gateway restart failed' }

$deadline = (Get-Date).AddSeconds(45)
$health = $null
do {
    Start-Sleep -Seconds 2
    try { $health = Invoke-RestMethod 'http://127.0.0.1:8644/health' -TimeoutSec 3 } catch { $health = $null }
} until ($health -or (Get-Date) -ge $deadline)
if (-not $health -or $health.status -ne 'ok') { throw 'Hermes webhook health check failed after restart' }

[PSCustomObject]@{
    trigger_secret = $triggerSecret
    callback_secret = $callbackSecret
    webhook_health = $health.status
    helper_path = (Join-Path $toolsDir 'dashboard_callback.py')
    focus_helper_path = (Join-Path $toolsDir 'focus_autosoft_rdp.py')
    config_backup = "$config.bak.dashboard-webhook.$timestamp"
} | ConvertTo-Json -Compress
