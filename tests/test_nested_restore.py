"""Tests for restoring a folder together with the locations nested inside it, which have snapshots of their own.

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


class NestedRestoreTest(unittest.TestCase):
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

    def restore(self, outer_snap, nested_snaps, keep_deleted=False):
        """Lose the folder, as in a disaster, then restore it with the nested snapshots, as the explorer's restore
        does. Returns what's restored, and the restore's record."""
        shutil.rmtree(self.outer)
        for snap in ke.list_snapshots(include_incomplete=True):
            ke.repository.snapshots[snap['id']] = snap
        job = ke.start_restore(outer_snap['id'], '', True, [s['id'] for s in nested_snaps], keep_deleted)
        deadline = time.time() + 120
        while not job['finished'] and time.time() < deadline:
            time.sleep(0.1)
        self.assertEqual(job['state'], 'done', job['error'])
        return files_in(work / 'restored' / self.outer.name), job

    def test_nested_location_left_out_of_outer(self):
        """The outer location leaves d out altogether, so d comes from its own snapshot"""
        write(self.outer / '.kopiaignore', '/d\n')
        write(self.outer / 'a.txt', 'a')
        write(self.nested / 'e.txt', 'e')
        nested = self.snapshot(self.nested)
        outer = self.snapshot(self.outer)
        restored, job = self.restore(outer, [nested])
        self.assertEqual(restored, {'.kopiaignore': '/d\n', 'a.txt': 'a', 'd/e.txt': 'e'})
        self.assertEqual(job['deleted'], [])

    def test_without_nested_locations(self):
        """Not including them restores only what the outer snapshot has"""
        write(self.outer / '.kopiaignore', '/d\n')
        write(self.outer / 'a.txt', 'a')
        write(self.nested / 'e.txt', 'e')
        self.snapshot(self.nested)
        outer = self.snapshot(self.outer)
        restored, _ = self.restore(outer, [])
        self.assertEqual(restored, {'.kopiaignore': '/d\n', 'a.txt': 'a'})

    def deleted_in_nested(self):
        """The outer location backs up d apart from its .iso files, and d is backed up more often: a file's
        deleted after the outer snapshot, and another changed, with a snapshot of d since"""
        write(self.outer / '.kopiaignore', '/d/*.iso\n')
        write(self.nested / 'old.txt', 'about to be deleted')
        write(self.nested / 'big.iso', 'only d has this')
        write(self.nested / 'e.txt', 'as it was')
        self.snapshot(self.nested)
        outer = self.snapshot(self.outer)
        (self.nested / 'old.txt').unlink()
        write(self.nested / 'e.txt', 'changed since')
        nested = self.snapshot(self.nested)
        return outer, nested

    def test_deleted_since_in_newer_nested_snapshot(self):
        """Newer copies come from d's snapshot, the .iso only it has is kept, and the file it shows deleted
        since isn't brought back"""
        outer, nested = self.deleted_in_nested()
        restored, job = self.restore(outer, [nested])
        self.assertEqual(restored, {'.kopiaignore': '/d/*.iso\n', 'd/e.txt': 'changed since', 'd/big.iso': 'only d has this'})
        self.assertEqual(job['deleted'], [str(self.outer / 'd' / 'old.txt')])

    def test_include_files_deleted_since(self):
        """Asked to, files shown deleted since are brought back too"""
        outer, nested = self.deleted_in_nested()
        restored, job = self.restore(outer, [nested], keep_deleted=True)
        self.assertEqual(restored, {'.kopiaignore': '/d/*.iso\n', 'd/e.txt': 'changed since', 'd/big.iso': 'only d has this',
                                    'd/old.txt': 'about to be deleted'})
        self.assertEqual(job['deleted'], [])

    def test_deleted_since_in_newer_outer_snapshot(self):
        """The other way round: the outer location is backed up more often, so it's the newer one. A file it
        shows deleted since isn't brought back from d's older snapshot, but the .iso it never backs up is."""
        write(self.outer / '.kopiaignore', '/d/*.iso\n')
        write(self.nested / 'notes.txt', 'as it was')
        write(self.nested / 'gone.txt', 'about to be deleted')
        write(self.nested / 'big.iso', 'only d has this')
        self.snapshot(self.outer)
        nested = self.snapshot(self.nested)
        write(self.nested / 'notes.txt', 'changed since')
        (self.nested / 'gone.txt').unlink()
        outer = self.snapshot(self.outer)
        restored, job = self.restore(outer, [nested])
        self.assertEqual(restored, {'.kopiaignore': '/d/*.iso\n', 'd/notes.txt': 'changed since', 'd/big.iso': 'only d has this'})
        self.assertEqual(job['deleted'], [str(self.outer / 'd' / 'gone.txt')])

    def test_no_snapshot_from_then(self):
        """With no snapshot of d from before the outer one, nothing can be told deleted, so everything's kept"""
        write(self.outer / '.kopiaignore', '/d/*.iso\n')
        write(self.nested / 'old.txt', 'about to be deleted')
        outer = self.snapshot(self.outer)
        (self.nested / 'old.txt').unlink()
        write(self.nested / 'big.iso', 'only d has this')
        nested = self.snapshot(self.nested)
        restored, job = self.restore(outer, [nested])
        self.assertEqual(restored, {'.kopiaignore': '/d/*.iso\n', 'd/old.txt': 'about to be deleted', 'd/big.iso': 'only d has this'})
        self.assertEqual(job['deleted'], [])

    def test_ignore_file_in_subfolder_read_from_snapshot(self):
        """d starts leaving out .log files in a subfolder, with an ignore file there, after the outer snapshot.
        The .log file isn't in d's newer snapshot, but its ignore file explains why, so it's restored from the
        outer one, even though the ignore file on disk was lost with everything else."""
        write(self.nested / 'sub' / 'notes.log', 'still here')
        write(self.nested / 'sub' / 'keep.txt', 'kept')
        self.snapshot(self.nested)
        outer = self.snapshot(self.outer)
        write(self.nested / 'sub' / '.kopiaignore', '*.log\n')
        nested = self.snapshot(self.nested)
        restored, job = self.restore(outer, [nested])
        self.assertEqual(restored, {'d/sub/notes.log': 'still here', 'd/sub/keep.txt': 'kept', 'd/sub/.kopiaignore': '*.log\n'})
        self.assertEqual(job['deleted'], [])


class NewestMergeTest(unittest.TestCase):
    """Merging a nested location's restore into the outer one's, keeping the later of each file and folder"""

    def test_newest_kept(self):
        folder = Path(tempfile.mkdtemp(dir=work))
        outer, nested = folder / 'outer', folder / 'nested'
        base, day = 1_700_000_000, 86_400

        def make(path, text, mtime):
            write(path, text)
            os.utime(path, (mtime, mtime))

        make(outer / 'newer-in-outer.txt', 'outer', base + day)
        make(nested / 'newer-in-outer.txt', 'nested', base)
        make(outer / 'newer-in-nested.txt', 'outer', base)
        make(nested / 'newer-in-nested.txt', 'nested', base + day)
        make(outer / 'same-time.txt', 'outer', base)
        make(nested / 'same-time.txt', 'nested', base)
        make(outer / 'sub' / 'only-outer.txt', 'outer', base)
        make(nested / 'sub' / 'only-nested.txt', 'nested', base)
        make(nested / 'new-folder' / 'x.txt', 'nested', base)
        for path, mtime in [(outer / 'sub', base + 5), (nested / 'sub', base + 50), (nested / 'new-folder', base + 7),
                            (outer, base + 10), (nested, base + 1)]:
            os.utime(path, (mtime, mtime))

        ke.move_into_place(nested, outer, newest=True)

        self.assertEqual(files_in(outer), {
            'newer-in-outer.txt': 'outer', 'newer-in-nested.txt': 'nested', 'same-time.txt': 'outer',
            'sub/only-outer.txt': 'outer', 'sub/only-nested.txt': 'nested', 'new-folder/x.txt': 'nested'})
        self.assertEqual({name: int((outer / name).stat().st_mtime) - base for name in ['', 'sub', 'new-folder']},
                         {'': 10, 'sub': 50, 'new-folder': 7})
        self.assertFalse(nested.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
