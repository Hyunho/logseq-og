"""Unix PTY integration: python3 scripts/journal-pty-test.py"""
import fcntl
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / 'journals').mkdir()
    clock = root / 'clock'
    clock.write_text('2026-11-02T12:00:00')
    preload = root / 'clock.cjs'
    preload.write_text("const fs=require('node:fs'); const OriginalDate=Date; global.Date=class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [fs.readFileSync(process.env.JOURNAL_TEST_CLOCK,'utf8')])); } };")
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 70, 0, 0))
    process = subprocess.Popen(['node', str(Path(__file__).with_name('journal.cjs')), '--graph', directory],
        stdin=slave, stdout=slave, stderr=slave,
        env={**os.environ, 'NODE_OPTIONS': '--require=' + str(preload), 'JOURNAL_TEST_CLOCK': str(clock)})
    def expect(text):
        output = b''
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                output += os.read(master, 65536)
                if text.encode() in output:
                    return output
        raise AssertionError((text, output.decode(errors='replace')))
    try:
        expect('생성 대기')
        journal = root / 'journals/2026_11_02.md'
        journal.write_text('- TODO parent\n  - child\n- DONE sibling\n')
        expect('☐ TODO parent')
        os.write(master, b'\x1b[D')
        screen = expect('▸')
        assert b'child' not in screen
        # Check buffering of fragmented terminal key sequences.
        os.write(master, b'\x1b[')
        time.sleep(0.01)
        os.write(master, b'C')
        expect('child')
        os.write(master, b'\x1b[200~ttt\x1b[201~t')
        expect('상태를 저장했습니다')
        assert journal.read_text() == '- DONE parent\n  - child\n- DONE sibling\n'
        os.write(master, b'\r')
        screen = expect('블록 보기')
        assert b'sibling' not in screen
        os.write(master, b'\x1b')
        expect('sibling')
        os.write(master, b't')
        expect('상태를 저장했습니다')
        assert journal.read_text().startswith('- TODO parent\n')
        replacement = root / 'replacement'
        replacement.write_text('- DONE parent\n  - child\n- DONE sibling\n- new content\n')
        replacement.replace(journal)
        expect('new content')
        os.write(master, b'?')
        expect('Journal TUI 단축키')
        os.write(master, b'?')
        expect('new content')
        (root / 'journals/2026_11_03.md').write_text('- TODO tomorrow\n')
        clock.write_text('2026-11-03T00:00:01')
        expect('tomorrow')
        os.write(master, b'q')
        expect('\x1b[?1049l')
        assert process.wait(timeout=3) == 0
        assert termios.tcgetattr(slave) == original
        print('PTY passed: waiting, creation, folding, fragmented keys, status save, block focus, atomic save, help, midnight, clean exit')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)
