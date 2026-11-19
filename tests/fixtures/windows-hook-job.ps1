param([string]$NodeExe,[string]$Parent,[string]$Config,[switch]$BlockBreakaway)
$ErrorActionPreference='Stop'
# Restrict only this fixture process and its children; change no user policy.
$env:PSExecutionPolicyPreference='Restricted'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HookJobFixture {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct SI { public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr data,uint size);
 [DllImport("kernel32",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string app,StringBuilder command,IntPtr a,IntPtr b,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32")] public static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32")] public static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32")] public static extern bool CloseHandle(IntPtr h);
}
'@
$job=[HookJobFixture]::CreateJobObject([IntPtr]::Zero,$null)
$limits=[Runtime.InteropServices.Marshal]::AllocHGlobal(144)
$pi=New-Object HookJobFixture+PI
try {
 for($i=0;$i -lt 144;$i++){[Runtime.InteropServices.Marshal]::WriteByte($limits,$i,0)}
 # Close only the fixture-owned job; the block case forbids its descendants from detaching.
 [Runtime.InteropServices.Marshal]::WriteInt32($limits,16,$(if($BlockBreakaway){0x2000}else{0x2800}))
 if(-not [HookJobFixture]::SetInformationJobObject($job,9,$limits,144)){throw 'fixture_job_flags_failed'}
 $si=New-Object HookJobFixture+SI;$si.cb=[Runtime.InteropServices.Marshal]::SizeOf($si)
 $cmd=New-Object Text.StringBuilder ('"'+$NodeExe+'" --experimental-strip-types "'+$Parent+'" "'+$Config+'"')
 if(-not [HookJobFixture]::CreateProcess($NodeExe,$cmd,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x08000004,[IntPtr]::Zero,[IO.Path]::GetDirectoryName($NodeExe),[ref]$si,[ref]$pi)){throw ('fixture_spawn_failed_'+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 if(-not [HookJobFixture]::AssignProcessToJobObject($job,$pi.process)){throw 'fixture_assign_failed'}
 [void][HookJobFixture]::ResumeThread($pi.thread)
 if([HookJobFixture]::WaitForSingleObject($pi.process,10000) -ne 0){throw 'fixture_parent_timeout'}
} finally {
 if($pi.thread -ne [IntPtr]::Zero){[void][HookJobFixture]::CloseHandle($pi.thread)}
 if($pi.process -ne [IntPtr]::Zero){[void][HookJobFixture]::CloseHandle($pi.process)}
 [void][HookJobFixture]::CloseHandle($job)
 [Runtime.InteropServices.Marshal]::FreeHGlobal($limits)
}
