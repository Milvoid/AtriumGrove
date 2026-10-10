#!/usr/bin/env python3
"""Install login-time Atrium Grove services under the current macOS user."""
import os, pathlib, plistlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[1]
state = pathlib.Path.home() / '.harbor'
node = root / '.tools/runtime/node_modules/node/bin/node'
loader = root / 'node_modules/tsx/dist/loader.mjs'
logs = state / 'logs'
logs.mkdir(mode=0o700, exist_ok=True)
launch_agents = pathlib.Path.home() / 'Library/LaunchAgents'
launch_agents.mkdir(exist_ok=True)
for name, args in [('control', ['serve', '--port', '4317']), ('host', ['host', 'start'])]:
    label = 'org.atriumgrove.harbor.' + name
    path = launch_agents / (label + '.plist')
    environment = {'PATH': str(node.parent) + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}
    # launchd does not source the login shell. Preserve the existing CLI provider
    # configuration only for the execution service, in its owner-only plist.
    if name == 'host':
        keys = ('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
                'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                'CLAUDE_CODE_OAUTH_TOKEN')
        prior = plistlib.loads(path.read_bytes()).get('EnvironmentVariables', {}) if path.exists() else {}
        for key in keys:
            value = os.environ.get(key, prior.get(key))
            if value is not None:
                environment[key] = value
    config = {
        'Label': label,
        'ProgramArguments': [str(node), '--import', str(loader), str(root / 'apps/control/src/cli.ts'), *args, '--state', str(state)],
        'WorkingDirectory': str(root),
        'EnvironmentVariables': environment,
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
        'ExitTimeOut': 30, 'ProcessType': 'Interactive' if name == 'host' else 'Background',
        'StandardOutPath': str(logs / (name + '.out.log')),
        'StandardErrorPath': str(logs / (name + '.err.log')),
    }
    path.write_bytes(plistlib.dumps(config)); path.chmod(0o600)
    if '--load' in sys.argv:
        subprocess.run(['launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(path)], check=True)
    print(label)
