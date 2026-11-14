"""Exercise the real full-screen CLI in a Windows ConPTY session."""
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time

from winpty import Backend, PtyProcess


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node.exe')
CLI = str(ROOT / 'bin' / 'projectfreeze.js')
FIXTURE = str(ROOT / 'examples' / 'stream-test.mjs')


def eventually(check, message, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(message)


def main():
    with tempfile.TemporaryDirectory(prefix='pf-terminal-') as directory:
        cwd = Path(directory).resolve()
        recipe = cwd / 'stream.json'
        env = dict(os.environ, PROJECTFREEZE_HOME=str(cwd / 'state'), NO_COLOR='1')
        env.pop('TERM', None)
        options = dict(cwd=cwd, env=env, text=True, capture_output=True, timeout=35)

        def cli(*args):
            result = subprocess.run([NODE, CLI, '--json', *args], **options)
            if result.returncode:
                raise AssertionError(result.stdout or result.stderr)
            return json.loads(result.stdout)['data']

        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        subprocess.run([NODE, FIXTURE, '--recipe', str(recipe), str(port)], check=True, **options)
        project = None
        term = None
        transcript = []

        def output():
            return ''.join(transcript)

        def expect(text, offset=0):
            try:
                return eventually(lambda: text in output()[offset:], f'Terminal did not display {text!r}')
            except AssertionError as error:
                raise AssertionError(f'{error}\n{output()[-5000:]}') from error

        def send(keys, text):
            offset = len(output())
            term.write(keys)
            expect(text, offset)

        try:
            project = cli('run', '--recipe', str(recipe))['projects'][0]
            command = [NODE, CLI, 'menu']
            term = PtyProcess.spawn(command, cwd=str(cwd), env=env, dimensions=(26, 100), backend=Backend.ConPTY)

            def read_terminal():
                with contextlib.suppress(EOFError, OSError):
                    while term.isalive():
                        transcript.append(term.read(4096))

            threading.Thread(target=read_terminal, daemon=True).start()
            expect('[Projects]')
            expect(cwd.name)
            term.write('\x1b[B')
            send('\t', '[TCP listeners]')
            send('/', 'Search tcp listeners')
            term.write(str(port))
            send('\r', f'127.0.0.1:{port}')
            term.setwinsize(14, 48)
            send('\x1b[Z', '[Projects]')
            send('/', 'Search projects')
            term.write(cwd.name)
            send('\r', f'running {port}')
            term.setwinsize(26, 100)
            send('\r', f'TCP listeners: 127.0.0.1:{port}')
            before = cli('inspect', project)
            pid = next(row['pid'] for row in before['processes'] if any(item['port'] == port for item in row['ports']))
            send('z', 'Enter Confirm')
            send('\x1b', f'TCP listeners: 127.0.0.1:{port}')
            send('z', 'Enter Confirm')
            send('\r', 'Sleep complete')
            with socket.socket() as connection:
                connection.settimeout(3)
                assert connection.connect_ex(('127.0.0.1', port)) != 0, 'Sleep retained the TCP listener'
            expect('[sleeping]')
            send('w', 'Enter Confirm')
            send('\r', 'Wake complete')
            with socket.create_connection(('127.0.0.1', port), timeout=5) as connection:
                connection.sendall(b'GET /stream HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
                data = b''
                while not re.search(rb'PID=(\d+)', data):
                    chunk = connection.recv(4096)
                    assert chunk, 'Stream ended before reporting its PID'
                    data += chunk
                new_pid = int(re.search(rb'PID=(\d+)', data)[1])
                assert pid != new_pid, 'Wake reused the process that was supposed to exit'
            term.write('q')
            eventually(lambda: not term.isalive(), 'q did not return control to the terminal')
            print(f'ConPTY keyboard, resize, confirmation and live stream verified: PID {pid} → closed → PID {new_pid}')
        finally:
            if term and term.isalive():
                term.close(force=True)
            if project:
                with contextlib.suppress(AssertionError):
                    cli('sleep', project)
            with contextlib.suppress(AssertionError):
                cli('daemon', 'stop')
            time.sleep(0.5)


if __name__ == '__main__':
    main()
