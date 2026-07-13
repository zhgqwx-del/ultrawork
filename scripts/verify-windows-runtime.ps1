# verify-windows-runtime.ps1 — Windows 真机运行时验收（ADR-045 动态端口 / 孤儿回收 / 单实例）
#
# 为什么需要它：这些代码路径在 macOS/Linux 上永远不执行，而 CI 只跑编译和单测、
# 不启动真 app。它们从落地起就没有在任何一台 Windows 上真正跑过。
#
# 为什么断言不读日志：release 构建是 GUI 子系统程序，没有控制台，`println!` 的输出
# 无处可去。所以每一条断言都建立在**可观测状态**上 —— ports.json 的内容、tasklist
# 里进程的死活 —— 而不是"日志里说它做了"。
#
# 用法（普通 PowerShell 即可，不需要管理员）：
#   1. 先关掉 Ultrawork
#   2. pwsh -File verify-windows-runtime.ps1
#
# 每项独立，失败不中断后续。结尾给汇总。

$ErrorActionPreference = 'Stop'
$PortsJson = Join-Path $env:USERPROFILE '.ultrawork\run\ports.json'
$Results = [ordered]@{}

function Find-AppExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Ultrawork\Ultrawork.exe'),
        (Join-Path $env:ProgramFiles 'Ultrawork\Ultrawork.exe')
    )
    $hit = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $hit) { throw "找不到 Ultrawork.exe，试过：`n  $($candidates -join "`n  ")" }
    $hit
}

function Get-App { Get-Process -Name 'Ultrawork' -ErrorAction SilentlyContinue | Select-Object -First 1 }

function Wait-For([scriptblock]$Cond, [int]$TimeoutSec = 45, [string]$What = 'condition') {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        if (& $Cond) { return $true }
        Start-Sleep -Milliseconds 400
    }
    Write-Host "  ⏱ 等待超时（${TimeoutSec}s）：$What" -ForegroundColor DarkYellow
    $false
}

function Start-App {
    Start-Process -FilePath (Find-AppExe) | Out-Null
    [void](Wait-For { Test-Path $PortsJson } 60 'ports.json 出现')
    # 关键：ports_json_doc 每次都写全四个 key，所以"有 4 个条目"从第一次写入起就成立 ——
    # 用它当等待条件等于没等。真正的就绪信号是**四个 pid 都落定**。
    [void](Wait-For { @((Read-Ports).Values | Where-Object { $_.Pid }).Count -ge 4 } 90 '四个 sidecar 全部就绪（pid 落定）')
    Start-Sleep -Seconds 2
}

function Stop-AppGracefully {
    $app = Get-App
    if (-not $app) { return }
    # CloseMainWindow 走正常关窗路径 ⇒ 触发 Tauri RunEvent::Exit ⇒ shutdown_sidecars。
    # 不能用 taskkill /F —— 那是崩溃路径，恰恰是 Test-B 要模拟的东西。
    [void]$app.CloseMainWindow()
    [void](Wait-For { -not (Get-App) } 30 'app 退出')
}

# ports.json → @{ name = @{ port; pid } }
function Read-Ports {
    if (-not (Test-Path $PortsJson)) { return @{} }
    try { $doc = Get-Content $PortsJson -Raw | ConvertFrom-Json } catch { return @{} }
    $out = @{}
    foreach ($p in $doc.PSObject.Properties) {
        if ($null -ne $p.Value.port) {
            $out[$p.Name] = [pscustomobject]@{ Port = [int]$p.Value.port; Pid = $p.Value.pid }
        }
    }
    $out
}

function Test-PidAlive([int]$ProcId) {
    $null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

function Assert([string]$Name, [bool]$Ok, [string]$Detail = '') {
    $Results[$Name] = $Ok
    $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
    $col = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("  [{0}] {1}{2}" -f $tag, $Name, $(if ($Detail) { " — $Detail" } else { '' })) -ForegroundColor $col
}

# ─────────────────────────────────────────────────────────────────
Write-Host "`n准备：确保 Ultrawork 未在运行" -ForegroundColor Cyan
Stop-AppGracefully
if (Test-Path $PortsJson) {
    Write-Host "  上次运行残留了 ports.json —— 先删掉，让每项测试从干净状态开始" -ForegroundColor DarkYellow
    Remove-Item $PortsJson -Force
}

# ── A. ports.json 生命周期（write_ports_json 的 Windows 分支从未真正执行过）────
Write-Host "`n[A] ports.json 生命周期" -ForegroundColor Cyan
Start-App
$portsA = Read-Ports
Assert 'A1 ports.json 被创建' (Test-Path $PortsJson) $PortsJson
# 不能只数条目 —— 四个 key 恒在。要数的是"带 pid 的条目"。
$withPid = @($portsA.Values | Where-Object { $_.Pid })
Assert 'A2 四个 sidecar 都写入了 pid' ($withPid.Count -eq 4) ("带 pid 的条目 {0}/4：{1}" -f $withPid.Count, (($portsA.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value.Port)/$($_.Value.Pid)" }) -join ' '))
$pidsAlive = $withPid | ForEach-Object { Test-PidAlive $_.Pid }
Assert 'A3 记录的 pid 都是活进程' ($withPid.Count -gt 0 -and $pidsAlive -notcontains $false) '（pid 是"这是我们自己的进程"的唯一凭据 —— 孤儿回收靠它）'

Stop-AppGracefully
Assert 'A4 干净退出后 ports.json 被删除' (-not (Test-Path $PortsJson)) '（它的存在与否就是"上次是否崩溃"的信号）'
$survivors = @($portsA.Values | Where-Object { $_.Pid -and (Test-PidAlive $_.Pid) })
Assert 'A5 干净退出后 sidecar 全部终止' ($survivors.Count -eq 0) ("残留 {0} 个" -f $survivors.Count)

# ── B. 崩溃后的孤儿回收（reap_orphaned_sidecars）────────────────────────────
Write-Host "`n[B] 崩溃 → 孤儿回收" -ForegroundColor Cyan
Start-App
$portsB1 = Read-Ports
$oldPids = @($portsB1.Values | Where-Object { $_.Pid } | ForEach-Object { $_.Pid })

# 只强杀主进程，sidecar 留下 —— 这正是 SIGKILL / 强制结束任务 的形态，
# 也是 RunEvent::Exit 覆盖不到的那条路径。
$app = Get-App
Start-Process taskkill -ArgumentList "/F","/PID","$($app.Id)" -NoNewWindow -Wait
[void](Wait-For { -not (Get-App) } 20 '主进程被强杀')
Start-Sleep -Seconds 2

$orphans = @($oldPids | Where-Object { Test-PidAlive $_ })
Assert 'B1 强杀主进程后 sidecar 成为孤儿' ($orphans.Count -gt 0) ("{0} 个孤儿存活（这是前提，不是缺陷）" -f $orphans.Count)
Assert 'B2 ports.json 未被清理（=崩溃信号）' (Test-Path $PortsJson) ''

Start-App   # 重启 → 启动时应回收孤儿
$stillAlive = @($oldPids | Where-Object { Test-PidAlive $_ })
Assert 'B3 重启后旧孤儿被回收' ($stillAlive.Count -eq 0) ("仍存活 {0} 个：{1}" -f $stillAlive.Count, ($stillAlive -join ','))
$portsB2 = Read-Ports
$newPids = @($portsB2.Values | Where-Object { $_.Pid } | ForEach-Object { $_.Pid })
$overlap = @($newPids | Where-Object { $oldPids -contains $_ })
Assert 'B4 ports.json 记录的是新 pid' ($overlap.Count -eq 0) ''

# ── C. 单实例（tauri-plugin-single-instance）──────────────────────────────
Write-Host "`n[C] 单实例" -ForegroundColor Cyan
$before = Read-Ports
Start-Process -FilePath (Find-AppExe) | Out-Null
Start-Sleep -Seconds 6
$procCount = (Get-Process -Name 'Ultrawork' -ErrorAction SilentlyContinue).Count
Assert 'C1 第二次启动不产生第二个进程' ($procCount -eq 1) ("Ultrawork.exe 进程数 = $procCount")
$after = Read-Ports
$same = $true
foreach ($k in $before.Keys) {
    if (-not $after.ContainsKey($k) -or $before[$k].Pid -ne $after[$k].Pid) { $same = $false }
}
Assert 'C2 sidecar 没有被重启一套' $same '（否则会出现两个 gateway 抢同一条 IM 长连接、两个 writer 写同一个 SQLite）'

Stop-AppGracefully

# ── D. 端口被占时的动态回退 ────────────────────────────────────────────────
Write-Host "`n[D] 4096 被别人占住时的动态回退" -ForegroundColor Cyan

# 占位者必须是**独立进程**，不能是本脚本自己：如果「不误伤旁观者」的保护失效、app
# 真的去杀了 4096 的占用者，那它杀掉的就是这个 PowerShell —— 脚本当场死掉，你只会
# 看到窗口消失，拿不到任何结论。而那恰恰是最该被报告出来的失败。
$squatter = Start-Process pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-Command',
    '$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,4096); $l.Start(); Start-Sleep -Seconds 300; $l.Stop()'
)
try {
    Start-Sleep -Seconds 3
    if (-not (Test-PidAlive $squatter.Id)) { throw "占位进程没起来（4096 可能已被别的程序占用）" }
    Write-Host "  已用一个无关进程（pid $($squatter.Id)）占住 127.0.0.1:4096 —— 模拟用户自己的程序" -ForegroundColor DarkGray

    Start-App
    $portsD = Read-Ports
    $oc = $portsD['opencode']
    Assert 'D1 opencode 回退到了别的端口' ($oc -and $oc.Port -ne 4096) ("实际端口 = {0}" -f $(if ($oc) { $oc.Port } else { '未登记' }))
    Assert 'D2 占位的旁观者没有被杀' (Test-PidAlive $squatter.Id) '（4096 非 IANA 保留段 —— 占用者很可能是用户自己的编辑器/数据库/隧道；宁可让出端口，也不能杀旁观者）'
    Stop-AppGracefully
} finally {
    Stop-Process -Id $squatter.Id -Force -ErrorAction SilentlyContinue
}

# ── 汇总 ──────────────────────────────────────────────────────────────────
Write-Host "`n════════ 汇总 ════════" -ForegroundColor Cyan
$fail = @($Results.GetEnumerator() | Where-Object { -not $_.Value })
foreach ($r in $Results.GetEnumerator()) {
    Write-Host ("  {0}  {1}" -f $(if ($r.Value) { '✅' } else { '❌' }), $r.Key)
}
if ($fail.Count -eq 0) {
    Write-Host "`n全部通过（$($Results.Count) 项）" -ForegroundColor Green
} else {
    Write-Host "`n$($fail.Count)/$($Results.Count) 项失败 —— 把上面的输出发回来" -ForegroundColor Red
}
Write-Host "`n另外请留意（脚本测不了，只能靠你观察）：" -ForegroundColor Yellow
Write-Host "  · 首次启动时 Windows 防火墙/Defender 有没有弹提示（sidecar 绑环回端口）"
Write-Host "  · 整个过程有没有任何控制台窗口一闪而过（ADR-054 的回归检查）"
