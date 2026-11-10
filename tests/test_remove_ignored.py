"""Tests for removing what ignore rules leave out from the snapshots already taken.

Each test makes folders and backs them up, adds ignore rules, then works out what removing what they ignore would
remove, and how much space it would free, and removes it, through the explorer's own plan and removal. Everything runs
against a repository of its own in a temporary folder, through kopia's environment variables, so the real repository,
its policies and KopiaUI are never touched, and it's all deleted afterwards.

    py tests/test_remove_ignored.py
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


class RemoveIgnoredTest(unittest.TestCase):
    """Each test has a folder of its own to back up"""

    def setUp(self):
        self.src = work / 'sources' / self._testMethodName
        self.src.mkdir(parents=True)

    def snapshot(self, folder):
        """Back a folder up now, returning the snapshot, a second or more after the last, as the explorer compares
        their times to the second"""
        ke.kopia('snapshot', 'create', str(folder))
        snap = max(ke.list_snapshots(str(folder)), key=lambda s: s['startTime'])
        time.sleep(1.1)
        return snap

    def plan(self, path, locations):
        """What removing what a folder's ignore rules (or the global ones, for None) ignore would remove from some
        locations' snapshots, once it's worked out"""
        ke.repository.storage()
        status = ke.plan_removal(None if path is None else str(path), [str(loc) for loc in locations])
        deadline = time.time() + 300
        while ke.removal_plans[status['id']].state == 'working' and time.time() < deadline:
            time.sleep(0.1)
        plan = ke.removal_plans[status['id']]
        self.assertEqual(plan.state, 'done', plan.error)
        return plan

    def remove(self, plan, rules):
        job = ke.start_removal(plan.id, rules)
        deadline = time.time() + 300
        while not job['finished'] and time.time() < deadline:
            time.sleep(0.1)
        return job

    @staticmethod
    def paths(folder):
        """Every file and folder in each of a location's snapshots, oldest first, by its path in the location"""
        snaps = sorted(ke.list_snapshots(str(folder), include_incomplete=True), key=lambda s: s['startTime'])
        return [{line.split(None, 6)[6].rstrip('/') for line in ke.kopia('ls', '-r', '-l', s['rootEntry']['obj']).splitlines()
                 if len(line.split(None, 6)) == 7} for s in snaps]

    def test_removes_an_ignored_folder_from_every_snapshot(self):
        """A folder that's ignored now goes from every snapshot, every version of what's in it counted once by its
        path, keeping pins; the one file in it that's the same as one that stays frees nothing"""
        write(self.src / 'keep' / 'a.txt', 'a')
        write(self.src / 'junk' / 'big.bin', os.urandom(12 * MB))
        write(self.src / 'junk' / 'small.txt', 'a')
        ke.kopia('snapshot', 'pin', self.snapshot(self.src)['id'], '--add=test-pin')
        # Pinned, it's saved again under a new ID
        first = ke.list_snapshots(str(self.src))[0]
        write(self.src / 'junk' / 'big.bin', os.urandom(12 * MB))
        self.snapshot(self.src)
        write(self.src / '.kopiaignore', 'junk/\n')
        plan = self.plan(self.src, [self.src])
        result = plan.evaluate(['junk/'])
        self.assertEqual((result['files'], result['snapshots'], result['skipped']), (2, 2, 0))
        self.assertGreater(result['bytes'], 24 * MB)
        self.assertLess(result['freed'], result['bytes'])
        self.assertGreater(result['freed'], 24 * MB)
        self.assertEqual(plan.rules['junk/']['files'], 2)

        job = self.remove(plan, ['junk/'])
        self.assertEqual(job['state'], 'done', job['error'])
        self.assertEqual(len(job['renamed']), 2)
        for paths in self.paths(self.src):
            self.assertEqual(paths, {'keep', 'keep/a.txt'})
        pinned = [s for s in ke.list_snapshots(str(self.src)) if 'test-pin' in (s.get('pins') or [])]
        self.assertEqual(len(pinned), 1)
        self.assertEqual(job['renamed'][first['id']], pinned[0]['id'])

    def test_file_also_somewhere_staying_stays(self):
        """Kopia removes by object ID, wherever it is, so an ignored file that's the same as one that stays can't be"""
        write(self.src / 'keep' / 'b.txt', 'same')
        write(self.src / 'x.tmp', 'same')
        write(self.src / 'y.tmp', 'different')
        self.snapshot(self.src)
        write(self.src / '.kopiaignore', '*.tmp\n')
        plan = self.plan(self.src, [self.src])
        result = plan.evaluate(['*.tmp'])
        self.assertEqual((result['files'], result['skipped']), (1, 1))
        job = self.remove(plan, ['*.tmp'])
        self.assertEqual(job['state'], 'done', job['error'])
        self.assertEqual(self.paths(self.src), [{'keep', 'keep/b.txt', 'x.tmp'}])

    def test_brought_back_stays(self):
        """A file a ! rule brings back isn't ignored, so it stays"""
        write(self.src / 'keep.log', 'kept')
        write(self.src / 'other.log', 'gone')
        write(self.src / 'notes.txt', 'notes')
        self.snapshot(self.src)
        write(self.src / '.kopiaignore', '*.log\n!keep.log\n')
        plan = self.plan(self.src, [self.src])
        self.assertEqual(plan.evaluate(['*.log'])['files'], 1)
        job = self.remove(plan, ['*.log'])
        self.assertEqual(job['state'], 'done', job['error'])
        self.assertEqual(self.paths(self.src), [{'keep.log', 'notes.txt'}])

    def test_only_rules_picked_are_removed(self):
        """A rule not picked keeps what it ignores, and nothing's removed from a folder a rule from elsewhere ignores"""
        write(self.src / 'a.tmp', 'a')
        write(self.src / 'b.bak', 'b')
        self.snapshot(self.src)
        write(self.src / '.kopiaignore', '*.tmp\n*.bak\n')
        plan = self.plan(self.src, [self.src])
        self.assertEqual(plan.evaluate(['*.tmp'])['files'], 1)
        self.assertEqual(plan.evaluate(['*.tmp', '*.bak'])['files'], 2)
        job = self.remove(plan, ['*.bak'])
        self.assertEqual(job['state'], 'done', job['error'])
        self.assertEqual(self.paths(self.src), [{'a.tmp'}])

    def test_nested_location_keeps_the_space(self):
        """Removing from a nested location frees nothing while the location around it keeps the same file, and all of
        it once both have it removed, counting the file once"""
        inner = self.src / 'd'
        write(inner / 'big.bin', os.urandom(12 * MB))
        write(inner / 'keep.txt', 'k')
        self.snapshot(self.src)
        self.snapshot(inner)
        write(inner / '.kopiaignore', 'big.bin\n')
        ke.repository.storage()
        self.assertEqual(ke.removable_from(str(inner)), sorted([str(self.src), str(inner)]))
        alone = self.plan(inner, [inner]).evaluate(['big.bin'])
        self.assertEqual((alone['files'], alone['snapshots']), (1, 1))
        self.assertEqual(alone['freed'], 0)
        both = self.plan(inner, [self.src, inner]).evaluate(['big.bin'])
        self.assertEqual((both['files'], both['snapshots']), (1, 2))
        self.assertGreater(both['freed'], 12 * MB)

    def test_other_versions_share_most_of_the_space(self):
        """A large file with the same name somewhere else, changed only at the end, shares most of its parts, so
        removing it frees far less than it takes"""
        other = work / 'sources' / f'{self._testMethodName}-other'
        data = os.urandom(40 * MB)
        write(self.src / 'junk' / 'data.bin', data)
        write(other / 'data.bin', data[:-1000] + os.urandom(1000))
        self.snapshot(self.src)
        self.snapshot(other)
        write(self.src / '.kopiaignore', 'junk/\n')
        result = self.plan(self.src, [self.src]).evaluate(['junk/'])
        self.assertEqual(result['files'], 1)
        self.assertGreater(result['bytes'], 40 * MB)
        self.assertLess(result['freed'], result['bytes'] * 0.4)

    def test_global_rules(self):
        """The global policy's rules apply from the top of each location going by them"""
        write(self.src / 'old.bak', 'b')
        write(self.src / 'sub' / 'older.bak', 'c')
        write(self.src / 'keep.txt', 'k')
        self.snapshot(self.src)
        ke.set_global_ignore(['*.bak'])
        try:
            plan = self.plan(None, [self.src])
            self.assertEqual(plan.evaluate(['*.bak'])['files'], 2)
            job = self.remove(plan, ['*.bak'])
            self.assertEqual(job['state'], 'done', job['error'])
            self.assertEqual(self.paths(self.src), [{'keep.txt', 'sub'}])
        finally:
            ke.set_global_ignore([])

    def test_refused_once_snapshots_change(self):
        """A snapshot made since it was worked out may have the same files somewhere they should stay, so nothing's
        removed"""
        write(self.src / 'a.tmp', 'a')
        self.snapshot(self.src)
        write(self.src / '.kopiaignore', '*.tmp\n')
        plan = self.plan(self.src, [self.src])
        write(self.src / 'b.txt', 'b')
        self.snapshot(self.src)
        job = self.remove(plan, ['*.tmp'])
        self.assertEqual(job['state'], 'failed')
        self.assertIn('changed', job['error'])
        self.assertEqual(self.paths(self.src)[0], {'a.tmp'})

    def test_batches_fit_on_a_command_line(self):
        self.assertEqual([len(b) for b in ke.command_batches(['x' * 99] * 5, room=250)], [2, 2, 1])
        self.assertEqual(ke.json_documents('{"a":1}{"b":2}\n {"c":3}'), [{'a': 1}, {'b': 2}, {'c': 3}])


if __name__ == '__main__':
    unittest.main()
