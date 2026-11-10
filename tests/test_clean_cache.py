"""Tests for clearing the explorer's cache of what no snapshot has any more.

Each test backs up folders, has the explorer cache what it would while browsing and checking what to remove, deletes
snapshots, then cleans the cache. Everything runs against a repository of its own in a temporary folder, through
kopia's environment variables, so the real repository and the explorer's own cache are never touched, and it's all
deleted afterwards.

    py tests/test_clean_cache.py
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
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ke = None       # kopia_explorer, imported once the test repository is set up, as importing it connects to one
work = None     # The temporary folder everything goes in
saved_env = {}  # The environment as it was, put back after
MB = 1_000_000


def setUpModule():
    global ke, work
    work = Path(tempfile.mkdtemp(prefix='kopia-explorer-test-'))
    env = {
        'KOPIA_CONFIG_PATH': str(work / 'repository.config'),
        'KOPIA_PASSWORD': 'kopia-explorer-test',
        'KOPIA_CACHE_DIRECTORY': str(work / 'cache'),
        'KOPIA_LOG_DIR': str(work / 'logs'),
        'KOPIA_CHECK_FOR_UPDATES': 'false',
        'TEMP': str(work / 'temp'), 'TMP': str(work / 'temp'),
        # The explorer's caches go in the temporary folder too
        'LOCALAPPDATA': str(work / 'appdata'),
    }
    for name, value in env.items():
        saved_env[name] = os.environ.get(name)
        os.environ[name] = value
    (work / 'temp').mkdir()
    tempfile.tempdir = None
    subprocess.run(['kopia', 'repository', 'create', 'filesystem', f'--path={work / "repository"}', '--no-persist-credentials'],
                   check=True, capture_output=True)
    # Imported afresh, as another test module run first leaves it connected to its own repository, with its pools shut
    sys.modules.pop('kopia_explorer', None)
    import kopia_explorer
    ke = kopia_explorer


def tearDownModule():
    if ke:
        ke.file_types.db.close()
        ke.chunk_lists.db.close()
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


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding='utf-8')


def folder_row(obj):
    return ke.file_types.db.execute('SELECT 1 FROM folders WHERE obj = ?', (obj,)).fetchone() is not None


def tally_row(obj):
    return ke.file_types.db.execute('SELECT 1 FROM tallies WHERE obj = ?', (obj,)).fetchone() is not None


def chunk_row(obj):
    return ke.chunk_lists.db.execute('SELECT 1 FROM chunks WHERE obj = ?', (obj,)).fetchone() is not None


class CleanCacheTest(unittest.TestCase):
    """Each test has a folder of its own to back up"""

    def setUp(self):
        self.src = work / 'sources' / self._testMethodName
        self.src.mkdir(parents=True)
        ke.removal_plans.clear()

    def snapshot(self, folder):
        """Back a folder up now, returning the snapshot, a second or more after the last, as the explorer compares
        their times to the second"""
        ke.kopia('snapshot', 'create', str(folder))
        snap = max(ke.list_snapshots(str(folder)), key=lambda s: s['startTime'])
        time.sleep(1.1)
        return snap

    @staticmethod
    def folder(snap, name):
        return next(e['o'] for e in ke.listing(snap['rootEntry']['obj']) if e['n'] == name)

    @staticmethod
    def large_file(folder, name):
        return next(oid for n, _, oid in ke.file_types.entries(folder)['f'] if n == name)

    @staticmethod
    def clean():
        ke.cleaning.acquire()
        ke.clean_cache()

    def wait_for_cleaning(self):
        deadline = time.time() + 60
        while ke.cleaning.locked() and time.time() < deadline:
            time.sleep(0.05)
        self.assertFalse(ke.cleaning.locked())

    def test_clears_what_a_deleted_snapshot_had(self):
        """A deleted snapshot's folders, its large file's parts, its listings and diffs go; what the snapshot left
        still has, including a folder both had, stays"""
        write(self.src / 'keep' / 'a.txt', 'a')
        write(self.src / 'junk' / 'big.bin', os.urandom(12 * MB))
        old = self.snapshot(self.src)
        write(self.src / 'junk' / 'big.bin', os.urandom(12 * MB))
        new = self.snapshot(self.src)
        ke.repository.storage()
        # Cached as browsing and checking what to remove would
        for snap in (old, new):
            ke.file_types.get(snap['rootEntry']['obj'])
            ke.listing(snap['rootEntry']['obj'])
        old_junk, new_junk, keep = self.folder(old, 'junk'), self.folder(new, 'junk'), self.folder(new, 'keep')
        self.assertEqual(keep, self.folder(old, 'keep'))
        old_big, new_big = self.large_file(old_junk, 'big.bin'), self.large_file(new_junk, 'big.bin')
        self.assertTrue(old_big.startswith('I') and new_big.startswith('I'))
        ke.chunk_lists.get([old_big, new_big])
        ke.raw_diff(old['id'], new['id'])
        diff = ke.diff_cache.folder / f'{old["id"]}-{new["id"]}.json'
        self.assertTrue(diff.exists() and chunk_row(old_big) and folder_row(old_junk))

        ke.kopia('snapshot', 'delete', old['id'], '--delete')
        # Anything cached once cleaning starts stays, so these were cached a moment before
        time.sleep(1.1)
        self.clean()

        for obj in (old['rootEntry']['obj'], old_junk):
            self.assertFalse(folder_row(obj), obj)
            self.assertFalse(tally_row(obj), obj)
        self.assertFalse((ke.listing_cache.folder / f'{old["rootEntry"]["obj"]}.json').exists())
        self.assertFalse(chunk_row(old_big))
        self.assertFalse(diff.exists())
        for obj in (new['rootEntry']['obj'], new_junk, keep):
            self.assertTrue(folder_row(obj), obj)
            self.assertTrue(tally_row(obj), obj)
        self.assertTrue((ke.listing_cache.folder / f'{new["rootEntry"]["obj"]}.json').exists())
        self.assertTrue(chunk_row(new_big))
        # Asked again, it's worked out afresh
        self.assertEqual(ke.file_types.get(new['rootEntry']['obj'])['.bin'][0], 1)

    def test_keeps_what_was_cached_after_it_started(self):
        """Rows and files cached after cleaning starts may be for snapshots made since, so they stay"""
        ke.file_types.db.execute("INSERT OR IGNORE INTO folders VALUES ('kstale', '{\"f\":[],\"d\":[]}')")
        ke.file_types.db.commit()
        last = ke.file_types.db.execute('SELECT MAX(rowid) FROM folders').fetchone()[0]
        ke.file_types.db.execute("INSERT OR IGNORE INTO folders VALUES ('knew', '{\"f\":[],\"d\":[]}')")
        ke.file_types.db.commit()
        self.assertGreaterEqual(ke.prune_rows(ke.file_types.db, ke.file_types.db_lock, 'folders', last, set()), 1)
        self.assertFalse(folder_row('kstale'))
        self.assertTrue(folder_row('knew'))

        before = time.time() - 60
        stale, fresh, partial = (ke.listing_cache.folder / name for name in ('kold.json', 'kfresh.json', 'kold.123.tmp'))
        for path in (stale, fresh, partial):
            path.write_text('[]', encoding='utf-8')
        for path in (stale, partial):
            os.utime(path, (before - 60, before - 60))
        self.assertEqual(ke.prune_files(ke.listing_cache, before, lambda key: False), 1)
        self.assertFalse(stale.exists() or partial.exists())
        self.assertTrue(fresh.exists())

    def test_once_a_day_when_idle(self):
        """It starts once the explorer hasn't been used for a couple of minutes, apart from what the page asks for by
        itself, unless it was done less than a day ago, or a removal check is reading the cache"""
        write(self.src / 'a.txt', 'a')
        self.snapshot(self.src)
        self.wait_for_cleaning()
        ke.CLEANED_PATH.unlink(missing_ok=True)

        def check(was_used):
            ke.last_used = was_used
            ke.clean_cache_when_idle()
            self.wait_for_cleaning()
            return ke.CLEANED_PATH.exists()

        self.assertFalse(check(time.time() - ke.IDLE + 10))
        ke.removal_plans[0] = SimpleNamespace(state='working', exact=False, refine_error=None, cancelled=False)
        self.assertFalse(check(time.time() - ke.IDLE))
        ke.removal_plans.clear()
        self.assertTrue(check(time.time() - ke.IDLE))

        day_ago = time.time() - 23 * 3600
        os.utime(ke.CLEANED_PATH, (day_ago, day_ago))
        check(time.time() - ke.IDLE)
        self.assertAlmostEqual(ke.CLEANED_PATH.stat().st_mtime, day_ago, delta=1)

        # The page keeping up by itself isn't someone using it; anything else is
        ke.last_used = 0
        ke.used('/api/jobs', polled=True)
        self.assertEqual(ke.last_used, 0)
        ke.used('/api/listing', polled=True)
        self.assertGreater(ke.last_used, 0)
        ke.last_used = 0
        ke.used('/api/actions')
        self.assertGreater(ke.last_used, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
