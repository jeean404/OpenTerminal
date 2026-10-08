# fake-ssh.ps1 -- replays the ssh/sudo password timing that triggers the bug:
#   1) prompt "Password: " (no echo)
#   2) after reading, emit a bare newline: the prompt regex no longer matches,
#      but the shell prompt has NOT come back yet
#   3) stay silent for 3s (auth still in flight, TTY echo still off)
#   4) only then print the new shell prompt
# ASCII only: the .cmd shim is read in the OEM codepage.
Write-Host -NoNewline "Password: "
$null = Read-Host -AsSecureString
Write-Host ""
Start-Sleep -Seconds 3
Write-Host -NoNewline "[demo@fakehost ~]$ "
