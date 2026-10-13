"""Optional unprivileged Linux process-tree caps; no persistent services/config."""
from functools import lru_cache
import os
import shutil
import signal
import subprocess
import sys
import uuid

from .sources import external_env


@lru_cache(maxsize=1)
def cgroup_caps_available():
    runner = shutil.which('systemd-run')
    if not sys.platform.startswith('linux') or not runner or not os.path.exists('/usr/bin/true'):
        return False
    try:
        result = subprocess.run([runner, '--user', '--pipe', '--wait', '--collect', '--quiet',
                                 '-p', 'MemoryMax=256M', '-p', 'CPUQuota=100%', '/usr/bin/true'],
                                env=external_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def budget_command(command, prefs, env):
    if not cgroup_caps_available():
        return command, env, None
    unit = 'fs-index-' + uuid.uuid4().hex
    env = {**env, 'FS_WORKER_ENFORCEMENT': 'Linux cgroup CPU + aggregate memory caps'}
    wrapped = [shutil.which('systemd-run'), '--user', '--pipe', '--wait', '--collect', '--quiet',
               '--unit=' + unit, '--working-directory=' + os.getcwd(),
               '-p', 'Type=exec', '-p', 'MemoryMax=' + str(prefs['worker_memory_mb']) + 'M',
               '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=' + str(prefs['cpu_threads'] * 100) + '%',
               '-p', 'OOMPolicy=kill']
    # The user manager supplies standard session variables; pass only execution
    # paths and fs's owned workspace, not arbitrary API keys into unit properties.
    for key in ('PATH', 'PYTHONPATH', 'VIRTUAL_ENV', 'FS_WORKER_TMP', 'FS_WORKER_ENFORCEMENT'):
        if key in env:
            wrapped.append('--setenv=' + key + '=' + env[key])
    return [*wrapped, '--', *command], external_env(), unit


def terminate_tree(process, unit):
    if unit:
        try:
            subprocess.run(['systemctl', '--user', 'stop', unit], env=external_env(),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if process.poll() is None:
        try:
            if os.name == 'posix':
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            pass
