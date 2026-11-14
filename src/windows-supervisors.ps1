param([string]$Kind, [string]$Name, [string]$Action, [string]$Expected = '-')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Get-Sid([string]$Account) {
    if ($Account -match '^S-1-[0-9-]+$') { return $Account }
    return ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Digest($Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Compress -Depth 6)))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
try {
    if ($Kind -eq 'task') {
        if ($Name -notmatch '^\\(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,80}\\)*[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$') { exit 2 }
        $at = $Name.LastIndexOf('\')
        $folder = if ($at -eq 0) { '\' } else { $Name.Substring(0,$at) }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $task = $scheduler.GetFolder($folder).GetTask($Name.Substring($at + 1))
        $definition = $task.Definition
        $acl = [Security.AccessControl.RawSecurityDescriptor]::new($task.GetSecurityDescriptor(5))
        if ($definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Type -ne 0 -or
            (Get-Sid $definition.Principal.UserId) -ne $user -or $definition.Principal.RunLevel -ne 0 -or
            ($acl.Owner.Value -ne $user -and $acl.Owner.Value -ne 'S-1-5-32-544')) { exit 4 }
        foreach ($ace in $acl.DiscretionaryAcl) {
            if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and ($ace.AccessMask -band 0x500D0156) -ne 0 -and
                $ace.SecurityIdentifier.Value -notin @($user,'S-1-5-18','S-1-5-32-544')) { exit 4 }
        }
        $exec = $definition.Actions.Item(1)
        $xml = [xml]$task.Xml
        $mutable = $xml.DocumentElement.SelectSingleNode('*[local-name()="Settings"]/*[local-name()="Enabled"]')
        if ($mutable) { [void]$mutable.ParentNode.RemoveChild($mutable) }
        $fingerprint = Digest @($task.Path,$xml.OuterXml,$acl.Owner.Value,$exec.Path,$exec.WorkingDirectory)
        if ($Action -ne 'probe') {
            if ($fingerprint -ne $Expected) { exit 4 }
            if ($Action -notin @('disable','enable')) { exit 5 }
            if ($Action -eq 'disable' -and ($task.GetInstances(0).Count -ne 0 -or $task.State -eq 2)) { exit 6 }
            $task.Enabled = $Action -eq 'enable'
        }
        @{ path=$task.Path; fingerprint=$fingerprint; executable=$exec.Path; cwd=$exec.WorkingDirectory;
            enabled=[bool]$task.Enabled; active=($task.GetInstances(0).Count -ne 0 -or $task.State -eq 2) } | ConvertTo-Json -Compress
    } elseif ($Kind -eq 'scm') {
        if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$') { exit 2 }
        $service = Get-CimInstance Win32_Service -Filter "Name='$Name'"
        if (!$service) { exit 3 }
        if ($service.ServiceType -ne 'Own Process' -or $service.StartMode -ne 'Manual' -or
            (Get-Sid $service.StartName) -notin @($user,'S-1-5-19') -or $service.PathName -notmatch '^"([^"]+\.exe)"(?:\s|$)|^([^\s"]+\.exe)(?:\s|$)') { exit 4 }
        $binary = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        $controller = [System.ServiceProcess.ServiceController]::new($Name)
        try {
            if ($controller.DependentServices.Count -or $controller.ServicesDependedOn.Count) { exit 4 }
            $fingerprint = Digest @($service.Name,$service.PathName,$service.StartName,$service.ServiceType,$service.StartMode)
            if ($Action -ne 'probe') {
                if ($fingerprint -ne $Expected) { exit 4 }
                $method = @{ pause='PauseService'; resume='ResumeService'; stop='StopService'; start='StartService' }[$Action]
                if (!$method) { exit 5 }
                $result = Invoke-CimMethod -InputObject $service -MethodName $method
                if ($result.ReturnValue -eq 2) { exit 4 }
                if ($result.ReturnValue -in @(6,10)) { exit 6 }
                if ($result.ReturnValue -in @(1,5)) { exit 5 }
                if ($result.ReturnValue -ne 0) { exit 7 }
            }
            @{ path=$service.Name; fingerprint=$fingerprint; executable=$binary; state=$service.State; pid=$service.ProcessId;
                canPause=$service.AcceptPause; canStop=$service.AcceptStop } | ConvertTo-Json -Compress
        } finally { $controller.Dispose() }
    } else { exit 2 }
} catch {
    if ($_.Exception.HResult -in @(-2147024891,-2147217405)) { exit 4 }
    if ($_.Exception.HResult -in @(-2147024894,-2147217406)) { exit 3 }
    exit 7
}
