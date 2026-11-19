param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class PairWorkerProcess {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct SI { public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string app,StringBuilder command,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32")] public static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32")] public static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32")] public static extern bool CloseHandle(IntPtr h);
}
'@
$data=Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
$si=New-Object PairWorkerProcess+SI;$si.cb=[Runtime.InteropServices.Marshal]::SizeOf($si);$si.flags=1;$si.show=0
$pi=New-Object PairWorkerProcess+PI;$resumed=$false
try {
 if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$data.deadline){throw 'pair_worker_launch_expired'}
 $command=New-Object Text.StringBuilder ([string]$data.command)
 if(-not [PairWorkerProcess]::CreateProcess([string]$data.exe,$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x09000004,[IntPtr]::Zero,[string]$data.cwd,[ref]$si,[ref]$pi)){throw 'pair_worker_create_denied'}
 [IO.File]::WriteAllText([string]$data.receipt,(@{pid=[int]$pi.pid} | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 while(-not [IO.File]::Exists([string]$data.permit)){if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$data.deadline){throw 'pair_worker_permit_expired'};Start-Sleep -Milliseconds 20}
 if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$data.deadline){throw 'pair_worker_permit_expired'}
 if([PairWorkerProcess]::ResumeThread($pi.thread) -eq [uint32]::MaxValue){throw 'pair_worker_resume_failed'}
 $resumed=$true
} finally {
 if(-not $resumed -and $pi.process -ne [IntPtr]::Zero){[void][PairWorkerProcess]::TerminateProcess($pi.process,1)}
 if($pi.thread -ne [IntPtr]::Zero){[void][PairWorkerProcess]::CloseHandle($pi.thread)}
 if($pi.process -ne [IntPtr]::Zero){[void][PairWorkerProcess]::CloseHandle($pi.process)}
}