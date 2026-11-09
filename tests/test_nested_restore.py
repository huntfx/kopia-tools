"""Tests for restoring a folder together with the locations nested inside it, which have snapshots of their own.

Everything the folder's snapshot has comes from it; the nested snapshots only fill in the files its ignore rules
leave out, as when a folder inside it is backed up on its own instead, such as to keep fewer snapshots of it.

Each test makes folders, backs them up and changes them, as the backups would see happen over time, then deletes
them, as a disaster would, and restores them through the explorer's own restore. Everything runs against a
repository of its own in a temporary folder, through kopia's environment variables, so the real repository,
its policies and KopiaUI are never touched, and it's all deleted afterwards.

    py tests/test_nested_restore.py
    py -m unittest discover tests
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ke = None       # kopia_explorer, imported once the test repository is set up, as importing it connects to one
work = None     # The temporary folder everything goes in
saved_env = {}  # The environment as it was, put back after


def setUpModule():
    global ke, work
    work = Path(tempfile.mkdtemp(prefix='kopia-explorer-test-'))
    env = {
        'KOPIA_CONFIG_PATH': str(work / 'repository.config'),
        'KOPIA_PASSWORD': 'kopia-explorer-test',
        'KOPIA_CACHE_DIRECTORY': str(work / 'cache'),
        'KOPIA_LOG_DIR': str(work / 'logs'),
        'KOPIA_CHECK_FOR_UPDATES': 'false',
        # The explorer's caches go in the temporary folder too
        'TEMP': str(work / 'temp'), 'TMP': str(work / 'temp'),
    }
    for name, value in env.items():
        saved_env[name] = os.environ.get(name)
        os.environ[name] = value
    (work / 'temp').mkdir()
    tempfile.tempdir = None
    subprocess.run(['kopia', 'repository', 'create', 'filesystem', f'--path={work / "repository"}', '--no-persist-credentials'],
                   check=True, capture_output=True)
    import kopia_explorer
    ke = kopia_explorer
    # Where to restore to is a fixed folder, rather than asked in a folder picker
    ke.pick_restore_target = lambda snap, path, name, is_folder: work / 'restored' / name


def tearDownModule():
    if ke:
        ke.file_types.db.close()
        ke.pool.shutdown(wait=True, cancel_futures=True)
        ke.stats_pool.shutdown(wait=True, cancel_futures=True)
    subprocess.run(['kopia', 'repository', 'disconnect'], capture_output=True)
    for name, value in saved_env.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    tempfile.tempdir = None
    shutil.rmtree(work, ignore_errors=True)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def files_in(folder):
    """Every file in a folder, with what's in it, by its path inside the folder"""
    return {p.relative_to(folder).as_posix(): p.read_text(encoding='utf-8') for p in folder.rglob('*') if p.is_file()}


class Folders(unittest.TestCase):
    """Each test has a folder of its own, the outer location, with d inside it, the nested one"""

    def setUp(self):
        self.outer = work / 'sources' / self._testMethodName
        self.nested = self.outer / 'd'
        self.nested.mkdir(parents=True)
        shutil.rmtree(work / 'restored', ignore_errors=True)
        (work / 'restored').mkdir()

    def snapshot(self, folder):
        """Back a folder up now, returning the snapshot. Snapshots are a second or more apart, as the explorer
        compares their times to the second, and so are changes made after them."""
        ke.kopia('snapshot', 'create', str(folder))
        snap = max(ke.list_snapshots(str(folder)), key=lambda s: s['startTime'])
        time.sleep(1.1)
        return snap

    def known(self):
        """Every snapshot, as the explorer knows them once it's read them"""
        for snap in ke.list_snapshots(include_incomplete=True):
            ke.repository.snapshots[snap['id']] = snap

    def restore(self, outer_snap, nested_snaps):
        """Lose the folder, as in a disaster, then restore it with the nested snapshots, as the explorer's restore
        does. Returns what's restored."""
        shutil.rmtree(self.outer)
        self.known()
        job = ke.start_restore(outer_snap['id'], '', True, [s['id'] for s in nested_snaps])
        deadline = time.time() + 120
        while not job['finished'] and time.time() < deadline:
            time.sleep(0.1)
        self.assertEqual(job['state'], 'done', job['error'])
        return files_in(work / 'restored' / self.outer.name)


class NestedRestoreTest(Folders):
    """Restoring the outer location with d, from their snapshots, after both were lost"""

    def test_nested_location_left_out_of_outer(self):
        """The outer location leaves d out altogether, so d comes from its own snapshot"""
        write(self.outer / '.kopiaignore', '/d\n')
        write(self.outer / 'a.txt', 'a')
        write(self.nested / 'e.txt', 'e')
        write(self.nested / 'sub' / 'f.txt', 'f')
        nested = self.snapshot(self.nested)
        outer = self.snapshot(self.outer)
        restored = self.restore(outer, [nested])
        self.assertEqual(restored, {'.kopiaignore': '/d\n', 'a.txt': 'a', 'd/e.txt': 'e', 'd/sub/f.txt': 'f'})

    def test_without_nested_locations(self):
        """Not including them restores only what the outer snapshot has"""
        write(self.outer / '.kopiaignore', '/d\n')
        write(self.outer / 'a.txt', 'a')
        write(self.nested / 'e.txt', 'e')
        self.snapshot(self.nested)
        outer = self.snapshot(self.outer)
        self.assertEqual(self.restore(outer, []), {'.kopiaignore': '/d\n', 'a.txt': 'a'})

    def test_outer_copies_used(self):
        """The outer location backs up d apart from its .iso files, and d is backed up more often. Everything the
        outer snapshot has comes from it, even where d's snapshot has a newer copy, or has since lost a file; only
        the .iso it leaves out comes from d."""
        write(self.outer / '.kopiaignore', '/d/*.iso\n')
        write(self.nested / 'old.txt', 'deleted after the outer snapshot')
        write(self.nested / 'big.iso', 'only d has this')
        write(self.nested / 'e.txt', 'as it was')
        outer = self.snapshot(self.outer)
        (self.nested / 'old.txt').unlink()
        write(self.nested / 'e.txt', 'changed since')
        nested = self.snapshot(self.nested)
        restored = self.restore(outer, [nested])
        self.assertEqual(restored, {'.kopiaignore': '/d/*.iso\n', 'd/old.txt': 'deleted after the outer snapshot',
                                    'd/e.txt': 'as it was', 'd/big.iso': 'only d has this'})

    def test_file_type_left_out_everywhere(self):
        """The outer location leaves out every .abc file, anywhere in it, and d backs them up: only those come from
        d, wherever they are in it, with everything else from the outer snapshot"""
        write(self.outer / '.kopiaignore', '*.abc\n')
        write(self.outer / 'top.abc', 'left out, and not in d')
        write(self.nested / 'e.txt', 'as it was')
        write(self.nested / 'x.abc', 'x')
        write(self.nested / 'sub' / 'y.abc', 'y')
        write(self.nested / 'sub' / 'f.txt', 'f')
        outer = self.snapshot(self.outer)
        write(self.nested / 'e.txt', 'changed since')
        nested = self.snapshot(self.nested)
        self.known()
        self.assertTrue(ke.nested_additions(outer['id'], '', [nested['id']])[nested['id']])
        self.assertEqual(self.restore(outer, [nested]), {'.kopiaignore': '*.abc\n', 'd/e.txt': 'as it was', 'd/x.abc': 'x',
                                                         'd/sub/y.abc': 'y', 'd/sub/f.txt': 'f'})

    def test_file_deleted_before_outer_snapshot(self):
        """A file only d's older snapshot has, deleted before the outer snapshot, which doesn't leave it out,
        isn't filled in: only files the outer snapshot leaves out are"""
        write(self.outer / '.kopiaignore', '/d/*.iso\n')
        write(self.nested / 'gone.txt', 'deleted before the outer snapshot')
        write(self.nested / 'big.iso', 'only d has this')
        nested = self.snapshot(self.nested)
        (self.nested / 'gone.txt').unlink()
        outer = self.snapshot(self.outer)
        self.assertEqual(self.restore(outer, [nested]), {'.kopiaignore': '/d/*.iso\n', 'd/big.iso': 'only d has this'})

    def test_files_made_since_outer_snapshot(self):
        """Files made since the outer snapshot are only filled in from d's newer one if it leaves them out"""
        write(self.outer / '.kopiaignore', '/d/*.iso\n')
        write(self.nested / 'e.txt', 'e')
        outer = self.snapshot(self.outer)
        write(self.nested / 'new.txt', 'made since')
        write(self.nested / 'new.iso', 'made since, and left out')
        nested = self.snapshot(self.nested)
        self.assertEqual(self.restore(outer, [nested]), {'.kopiaignore': '/d/*.iso\n', 'd/e.txt': 'e',
                                                         'd/new.iso': 'made since, and left out'})

    def test_ignore_file_in_subfolder_read_from_snapshot(self):
        """The outer location leaves d out with an ignore file in a folder of its own, x, that d doesn't have.
        It's read from the outer snapshot, as the one on disk was lost with everything else."""
        nested = self.outer / 'x' / 'd'
        write(self.outer / 'x' / '.kopiaignore', '/d\n')
        write(self.outer / 'x' / 'other.txt', 'other')
        write(nested / 'e.txt', 'e')
        nested_snap = self.snapshot(nested)
        outer = self.snapshot(self.outer)
        self.assertEqual(self.restore(outer, [nested_snap]), {'x/.kopiaignore': '/d\n', 'x/other.txt': 'other', 'x/d/e.txt': 'e'})



class NestedAdditionsTest(Folders):
    """Which nested locations have anything to add to the outer snapshot, as only those are offered: files it
    leaves out"""

    def adds(self, outer_snap, nested_snap):
        self.known()
        return ke.nested_additions(outer_snap['id'], '', [nested_snap['id']])[nested_snap['id']]

    def test_left_out_of_outer(self):
        write(self.outer / '.kopiaignore', '/d\n')
        write(self.nested / 'e.txt', 'e')
        nested = self.snapshot(self.nested)
        self.assertTrue(self.adds(self.snapshot(self.outer), nested))

    def test_file_outer_leaves_out(self):
        write(self.outer / '.kopiaignore', '/d/*.iso\n')
        write(self.nested / 'e.txt', 'e')
        write(self.nested / 'big.iso', 'only d has this')
        nested = self.snapshot(self.nested)
        self.assertTrue(self.adds(self.snapshot(self.outer), nested))

    def test_same_as_outer(self):
        write(self.nested / 'e.txt', 'e')
        nested = self.snapshot(self.nested)
        self.assertFalse(self.adds(self.snapshot(self.outer), nested))

    def test_newer_copy(self):
        """A newer copy of a file the outer snapshot has isn't anything to add, as its copy is used"""
        write(self.nested / 'e.txt', 'as it was')
        outer = self.snapshot(self.outer)
        write(self.nested / 'e.txt', 'changed since')
        self.assertFalse(self.adds(outer, self.snapshot(self.nested)))

    def test_file_made_since(self):
        """Nor is a file made since the outer snapshot, which it doesn't leave out"""
        write(self.nested / 'e.txt', 'e')
        outer = self.snapshot(self.outer)
        write(self.nested / 'new.txt', 'made since')
        self.assertFalse(self.adds(outer, self.snapshot(self.nested)))


class MoveLeftOutTest(unittest.TestCase):
    """Moving what the outer snapshot left out from a nested location's restore into the outer one's, on folders
    made here rather than restored, as kopia gives the folders inside a snapshot modified times of its own"""

    def test_move_left_out(self):
        folder = Path(tempfile.mkdtemp(dir=work))
        outer, nested = folder / 'outer', folder / 'nested'
        base = 1_700_000_000

        def make(path, text):
            write(path, text)
            os.utime(path, (base, base))

        make(outer / 'e.txt', 'outer')
        make(nested / 'e.txt', 'nested, newer')
        os.utime(nested / 'e.txt', (base + 99, base + 99))
        make(nested / 'made-since.txt', 'nested, not left out')
        make(nested / 'big.iso', 'nested, left out')
        make(nested / 'sub' / 'f.txt', 'nested, in a folder left out')
        make(nested / 'empty-left-out' / '.keep', 'x')
        (nested / 'empty-left-out' / '.keep').unlink()
        make(nested / 'other' / 'g.txt', 'nested, in a folder not left out')
        for path, mtime in [(nested / 'sub', base + 7), (nested / 'empty-left-out', base + 8), (nested / 'other', base + 9),
                            (nested, base + 1), (outer, base + 10)]:
            os.utime(path, (mtime, mtime))

        left_out = lambda p, is_dir: p.suffix == '.iso' or p.parts[:1] in (('sub',), ('empty-left-out',))
        ke.move_left_out(nested, outer, left_out)

        self.assertEqual(files_in(outer), {'e.txt': 'outer', 'big.iso': 'nested, left out', 'sub/f.txt': 'nested, in a folder left out'})
        times = {name: int((outer / name).stat().st_mtime) - base for name in ['', 'sub', 'empty-left-out']}
        self.assertEqual(times, {'': 10, 'sub': 7, 'empty-left-out': 8})
        self.assertFalse((outer / 'other').exists())
        self.assertFalse(nested.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
