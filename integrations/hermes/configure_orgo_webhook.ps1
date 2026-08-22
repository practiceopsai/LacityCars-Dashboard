param(
    [string]$HermesHome = 'C:\Users\Administrator\AppData\Local\hermes',
    [string]$RagRoot = 'C:\Users\Administrator\Desktop\LaCity\Lacity Cars',
    [string]$CallbackOrigin = 'https://lacity-api-production.up.railway.app',
    [string]$PromptFile = "$PSScriptRoot\vehicle-ready-prompt.txt",
    [string]$CallbackHelper = "$PSScriptRoot\dashboard_callback.py",
    [string]$RdpFocusHelper = "$PSScriptRoot\focus_autosoft_rdp.py",
    [string]$AutoSoftPinHelper = "$PSScriptRoot\autosoft_pin_login.py",
    [string]$BatchSourceHelper = "$PSScriptRoot\batch_source_preflight.py",
    [string]$BatchManifestHelper = "$PSScriptRoot\batch_manifest_preflight.py",
    [string]$BatchPostingManifestHelper = "$PSScriptRoot\batch_posting_manifest.py",
    [string]$BatchDecodeHelper = "$PSScriptRoot\batch_vpic_decode.py",
    [string]$BatchCheckpointHelper = "$PSScriptRoot\batch_checkpoint.py"
)

$ErrorActionPreference = 'Stop'
$hermes = Join-Path $HermesHome 'hermes-agent\bin\hermes.exe'
$config = Join-Path $HermesHome 'config.yaml'
$envFile = Join-Path $HermesHome '.env'

foreach ($required in $hermes, $config, $envFile, $RagRoot, $PromptFile, $CallbackHelper, $RdpFocusHelper, $AutoSoftPinHelper, $BatchSourceHelper, $BatchManifestHelper, $BatchPostingManifestHelper, $BatchDecodeHelper, $BatchCheckpointHelper) {
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
# AutoSoft runs can otherwise retain hundreds of full desktop captures.  Keep
# only a small recent evidence tail and deterministically prune older, large
# tool results before they are resent on every subsequent model turn.
Set-ConfigValue 'compression.proactive_prune_tokens' '60000'
Set-ConfigValue 'compression.proactive_prune_min_result_chars' '6000'
Set-ConfigValue 'compression.proactive_prune_min_reclaim_tokens' '15000'
Set-ConfigValue 'compression.protect_last_n' '4'
# The stocking route is explicitly authorized to reuse the operator's saved
# Chrome sessions. This eliminates repeated native fallback and allows the
# typed browser layer to attach to the exact existing pid/window pair.
Set-ConfigValue 'computer_use.grant_existing_profile' 'true'
Set-ConfigValue 'LACITY_DASHBOARD_CALLBACK_SECRET' $callbackSecret
Set-DotEnvValue 'LACITY_DASHBOARD_CALLBACK_ORIGIN' $CallbackOrigin

$toolsDir = Join-Path $RagRoot 'tools'
New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
Copy-Item -LiteralPath $CallbackHelper -Destination (Join-Path $toolsDir 'dashboard_callback.py') -Force
Copy-Item -LiteralPath $RdpFocusHelper -Destination (Join-Path $toolsDir 'focus_autosoft_rdp.py') -Force
Copy-Item -LiteralPath $AutoSoftPinHelper -Destination (Join-Path $toolsDir 'autosoft_pin_login.py') -Force
Copy-Item -LiteralPath $BatchSourceHelper -Destination (Join-Path $toolsDir 'batch_source_preflight.py') -Force
Copy-Item -LiteralPath $BatchManifestHelper -Destination (Join-Path $toolsDir 'batch_manifest_preflight.py') -Force
Copy-Item -LiteralPath $BatchPostingManifestHelper -Destination (Join-Path $toolsDir 'batch_posting_manifest.py') -Force
Copy-Item -LiteralPath $BatchDecodeHelper -Destination (Join-Path $toolsDir 'batch_vpic_decode.py') -Force
Copy-Item -LiteralPath $BatchCheckpointHelper -Destination (Join-Path $toolsDir 'batch_checkpoint.py') -Force

# Keep RAG checkpoint pushes non-interactive and avoid the Windows credential
# selector that can otherwise hold the one shared desktop lease indefinitely.
& git -C $RagRoot config credential.helper store
& git -C $RagRoot config credential.interactive never
& git -C $RagRoot config http.version HTTP/1.1
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure non-interactive RAG Git access' }

# Workbook helpers must be ready before a timed live run. Never spend batch
# turns discovering or installing this dependency.
$hermesPython = Join-Path $HermesHome 'hermes-agent\venv\Scripts\python.exe'
& $hermesPython -c 'import openpyxl' 2>$null
if ($LASTEXITCODE -ne 0) {
    $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if (-not $uv) { throw 'openpyxl is missing and uv is unavailable' }
    & $uv pip install --python $hermesPython openpyxl | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install openpyxl in the Hermes environment' }
}

$contractBlock = @'
## Dashboard-triggered stocking runs

- A valid `vehicle.ready` event on the HMAC-authenticated `vehicle-stocking` webhook is explicit authorization to stock and post exactly the supplied vehicle for exactly the supplied store. It has the same live authority as an explicit stock-and-post message from the paired operator; do not request duplicate confirmation.
- Process only one dashboard vehicle in the webhook session. Treat `request_id` as the immutable run identity and never substitute a different VIN or store.
- Before a contiguous live-input phase inside Remote Desktop, run `python tools/focus_autosoft_rdp.py --expected-title <payload store.rdp_window_title>`, require `ok: true`, then capture once and visually verify the inner AutoSoft screen shows `<payload store.autosoft_instance>`. Keep that HWND foreground across the batch; re-run the guard only after an actual window/focus change or unexplained state. Never send background input to `mstsc.exe`. An `unverifiable` action requires one fresh visual capture before more input, not repeated blind clicking.
- At the visible Accounting PIN prompt, never search files, RAG, environment variables, chat, or logs for the secret. Run exactly once `python tools/autosoft_pin_login.py --expected-title <payload store.rdp_window_title> --request-id <current webhook request_id>`. The helper reads Windows Credential Manager and sends the secret only to the foreground authorized RDP window without exposing it. Require `ok: true`, then capture and verify that Accounting opened. If the helper fails, the prompt remains, or AutoSoft rejects authentication, report `AUTOSOFT_UNAVAILABLE` with batch scope; never retry, type a guessed PIN, or use another request ID.
- Use `tools/dashboard_callback.py` to send `PROCESSING` when live work begins and exactly one terminal `COMPLETED` or `FAILED` result after every mandatory RAG evaluation, commit, push, cleanup, and final evidence check is complete. The accepted terminal callback is the final side effect of the webhook run: after it returns accepted/idempotent, call no more tools and immediately return the concise result. The helper reads its signing secret from the environment; never reveal, print, copy, or place that secret in an artifact.
- The callback's `stock_number`, ACV, freight, final total, source/run summary, and RAG commit must come from verified run evidence. Any safety gate that blocks posting must be returned as `FAILED` with the exact reason.
'@

$scheduleBlock = @'
## Scheduled stocking boundary

- Every dashboard `vehicle.ready` payload includes `schedule.starts_at` as an ISO 8601 instant plus Eastern and Pacific display labels. The UTC instant is authoritative; the labels are operator-readable context.
- `schedule.starts_at` is a hard not-before boundary for all live stocking work because AutoSoft is shared. The worker already delays webhook delivery until that boundary. Independently verify it once using a fresh UTC clock command executed in the current webhook session immediately after writing `vehicle-stock-in/active-request.json`. Never reuse a timestamp from an earlier run, result, checkpoint, RAG excerpt, file, or model context; if an older artifact disagrees, the fresh clock is authoritative. Compare that value before opening or changing the stock sheet, NextGear, AutoSoft, or another live stocking system.
- If a trigger arrives early, fail closed: make no live-system changes and report the premature trigger. Never wait inside or hold open the shared AutoSoft session until the scheduled time.
- A scheduled time does not permit concurrency. Continue to process one dashboard vehicle at a time, and let later scheduled vehicles remain queued while another run owns the desktop.
- Store scheduling instants in UTC and show both America/New_York (Eastern) and America/Los_Angeles (Pacific), using their date-specific daylight-saving abbreviations.
'@

$batchBlock = @'
## Dashboard store-batch runs

- A `vehicle.batch_ready` event is one store-specific execution batch. Never combine stores or switch AutoSoft instances inside the run.
- Before touching a live system, overwrite exactly `vehicle-stock-in/active-request.json` with the exact current webhook payload. Never write a request beneath `.hermes/` because Hermes protects that instruction namespace and a headless approval would time out. Never locate or reuse another request artifact from an earlier retry. Parse that complete ordered manifest. Its top-level `request_id` must equal the current webhook request ID, every child request ID must begin with that current ID plus `:`, its array length must equal `batch.vehicle_count`, and every child needs a 17-character VIN. A stale/missing/truncated identity is a batch-wide failure: make no live changes and report one current child FAILED with `--failure-scope BATCH`.
- Preflight every supplied vehicle first. Accept complete dashboard freight evidence without reopening dispatch. Export and scan only the payload store's stock sheet; never fetch the other store's sheet during a store-isolated run. Before opening NextGear, run `tools/batch_source_preflight.py` against the newest Exportable Inventory workbook and all payload VINs. Reuse it when the helper returns `ready: true` (at most six hours old, one exact active approved row per VIN). `In Stock`, `At Auction`, and `Collateral Verified` are active vehicle statuses; when Floorplan Status is present it must be `Approved`. Otherwise open NextGear directly at Tools > Exportable Inventory and make one fresh export; never substitute Approved Floorplans for ACV/source evidence. Run the helper again and fail closed if it is still not ready. Then run `tools/batch_manifest_preflight.py --request <canonical-current-payload.json> --stock-sheet <target-store-export> --stock-prefix <payload store.stock_prefix> --expected-request-id <current webhook request_id> --output <manifest-validation.json>` and require `ready: true`; never create or debug a validator during a live run.
- Resolve color only for candidates whose configured sheet color cell is absent or blank. A `REUSE_EXISTING` row with a nonblank value in the store-configured color column already supplies verified color and must not be searched again. For only the remaining VINs, when the reusable export lacks color, use the authenticated NextGear Floor Plans list as a supplement. If Cox shows the saved-login flow, verify the expected saved username is already populated, click Next once, require a masked/autofilled password, and click Sign in once. Never type, copy, reveal, or persist the password; fail closed if it is not autofilled or authentication is rejected. Open Floor Plans once and search each still-missing full VIN sequentially in the same semantic search field. Require exactly one result and record the color shown in its Description; clear/replace the search value for the next VIN. If a fresh verification capture proves the field still contains the prior VIN (or is blank) after the first entry, perform exactly one recovery: refocus the verified field, Ctrl+A, paste the exact current VIN once, submit once, and capture the result. This is a verified replacement, not a blind duplicate; never make a third entry attempt. Do not open detail pages and do not rerun exports when the one-result list supplies color.
- After the evidence, sheet, and vPIC helpers are ready, run `python tools/batch_posting_manifest.py --request <canonical-current-payload.json> --evidence <batch-evidence.json> --validation <manifest-validation.json> --decode <batch-decode.json> --store-registry <current-store-yaml> --output <posting-manifest.json> --color <VIN=COLOR> ...` and require `ready: true`. It creates the compact posting manifest and exact TSV blocks. Never use `python -c`, PowerShell encoded commands, shell redirection, or hand-authored JSON/TSV for these artifacts because the headless approval will time out. Then do not enumerate downloads, reread old run artifacts, load unrelated skills, or make broad RAG searches. Permit at most one targeted RAG query for a genuinely missing store rule. Paste each generated contiguous authorized sheet block at once; never step through cells with Tab/Enter. Verify every written row from one independent export before opening AutoSoft.
- Deduplicate each VIN against the dashboard ledger, the named store sheet, and RAG checkpoints. Obey each `batch_manifest_preflight.py` candidate's `sheet_action`: append only `APPEND_NEW` blank tail rows; for `REUSE_EXISTING`, never append or rewrite and verify every populated cell against the current manifest before AutoSoft. `RESUME_EXISTING_TAIL_ROWS`, `REUSE_EXISTING_ROWS`, and `REUSE_EXISTING_AND_APPEND` are valid only when the helper returns `ready: true`; any other existing-row mode is a blocker. Never repost a vehicle with a terminal AutoSoft/readback checkpoint.
- Acquire a foreground RDP lease with `python tools/focus_autosoft_rdp.py --expected-title "<payload store.rdp_window_title>"` once before AutoSoft. Continue only when it returns `ok: true`, capture the fresh screen, and visually prove the inner instance is `<payload store.autosoft_instance>`. Keep that verified HWND foreground across vehicles; re-run only after an actual focus/window change or unexplained screen. Never send background input to `mstsc.exe`, and never type after an `unverifiable` action until one fresh capture proves state.
- Build one verified local posting manifest during preflight. Do not revisit the sheet, dispatch workbook, or browser between AutoSoft records unless a verification fails. Keep one foreground AutoSoft session and reuse the open Accounting/Inventory workflow while processing the ordered vehicles sequentially.
- Decode every ordered VIN once before AutoSoft with `tools/batch_vpic_decode.py`; use its single verified JSON artifact throughout the batch. Never author a decoder during a live run.
- For every text control, focus the visibly verified target, press Ctrl+A, and paste the exact current-vehicle manifest value, then visually/readback verify it. Create a fresh record and completely clear/verify/re-enter only the current VIN for every vehicle. Never paste a multi-vehicle block into AutoSoft. Store charge values may come from the verified store template; VIN, ACV, freight, mileage, title, color, source, and totals remain vehicle-specific.
- In the legacy purchase entry, currency fields use implied cents (`500.00` is typed as `50000`). Enter the debit template and freight first, set Invoice Amount to the vehicle ACV, then enter the credit template. Leave the inventory debit row amount alone: AutoSoft dynamically balances it back to full ACV as credits are committed. Freight belongs on the credit row whose GL is 31105; never put 31105 on the reserved Cash Purchase row, and verify every nonzero amount has the intended GL before Post. Decode before touching Line. If expected `9T` and GL 24100 are already visible, do not re-edit Line. If Line must be set, treat its numeric and suffix controls separately and re-verify `9T`, Used, and GL 24100 before posting.
- On the LA City home screen only, `CRITICAL ERROR ID 227, Position Error #7-0 in AAJ3` is a known one-dismiss startup alert. Click OK once, require the normal `LA City Cars` home, open Accounting, and continue only if its password/PIN prompt appears and accepts the configured saved credential. Treat recurrence inside posting, an unusable Accounting module, or rejected authentication as a batch-wide AutoSoft failure. Never generalize this recovery to another error.
- If Accounting reports an `Incomplete Direct Posting Entry`, dismiss once and inspect the recovery list without choosing `Finish Posting`. Record operator/date/stock/VIN suffix. Do not finish, delete, or overwrite an unrelated or collision-rejected draft; it requires separately authorized AutoSoft correction access or support. Continue only after a clean re-login proves the incomplete entry is resolved; otherwise fail the batch with the exact blocker.
- Send per-vehicle callbacks using each child `request_id`. After each verified readback, mark that manifest record VERIFIED_POSTED, commit/push its RAG checkpoint, send COMPLETED, and require an accepted/idempotent response before sending PROCESSING for or touching the next child. Never leave two children PROCESSING. This durable barrier prevents a resumed batch from reposting completed work.
- Use `tools/batch_checkpoint.py record` for every terminal manifest/checkpoint update, commit and push those exact files with terminal prompting disabled, finish all RAG evaluation and cleanup, then use `tools/batch_checkpoint.py callback` and `tools/dashboard_callback.py --payload-file ...`. Never hand-author, hand-patch, or repair JSON during a live run. Once the final terminal callback is accepted/idempotent, call no more tools and immediately return the concise batch result.
- If a rejected Post creates a stock/VIN shell with zero original inventory, zero internals, and no active journal data, do not retry the stock number, delete the shell, or declare success. Return a vehicle-scoped failure that explicitly requires authorized AutoSoft Edits & Corrections recovery; later siblings may continue only if the store session is otherwise clean.
- Isolate vehicle-specific failures and continue. For a store-wide safety failure, stop immediately and send one current-child FAILED callback with `--failure-scope BATCH`; the dashboard deterministically fails and releases all claimed siblings. Do not repeatedly attempt blind recovery.
- Record an absolute 20-minute preflight deadline when the run starts. Check it once immediately before the first live sheet mutation and once after the verified sheet transaction before AutoSoft; do not spend tool calls repeatedly querying the clock between browser actions. If it arrives before mutation, fail closed. Once a sheet block write begins, finish all authorized blocks and one independent export/readback as a single transaction; never stop with a partial batch row. Do not use full-screen captures as a polling loop. In Chrome, use the configured existing-profile browser attachment once when available, otherwise use native semantic input; after one browser-prepare refusal do not repeat setup attempts. Cua Driver 0.17 requires a fresh snapshot ID/token with an element index, and Chrome scroll, hotkey, and text input must use foreground delivery on this machine. For each search use one fresh capture, one foreground focus, Ctrl+A, one exact VIN entry, one submit, and one result capture. If that capture proves the field retained the old value or stayed blank, allow one verified clear-and-replace recovery; never make a third entry attempt. Use one fresh targeted SOM/AX capture after an unverifiable action. Capture on screen transitions and verification checkpoints, prefer compact terminal/readback evidence, stop after two identical tool failures, and fail closed at a safe transaction boundary when shared preflight reaches 20 minutes or a vehicle reaches 15 minutes without a verified checkpoint.
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
    trigger_secret_configured = ($triggerSecret.Length -ge 32)
    callback_secret_configured = ($callbackSecret.Length -ge 16)
    webhook_health = $health.status
    helper_path = (Join-Path $toolsDir 'dashboard_callback.py')
    focus_helper_path = (Join-Path $toolsDir 'focus_autosoft_rdp.py')
    batch_source_helper_path = (Join-Path $toolsDir 'batch_source_preflight.py')
    batch_manifest_helper_path = (Join-Path $toolsDir 'batch_manifest_preflight.py')
    batch_decode_helper_path = (Join-Path $toolsDir 'batch_vpic_decode.py')
    batch_checkpoint_helper_path = (Join-Path $toolsDir 'batch_checkpoint.py')
    config_backup = "$config.bak.dashboard-webhook.$timestamp"
} | ConvertTo-Json -Compress
