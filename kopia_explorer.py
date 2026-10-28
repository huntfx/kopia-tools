"""Browse kopia snapshots in a web page: backup locations, their snapshots, folder contents, what changed
between snapshots, and file histories, restore files and folders from any snapshot, back up a location now,
delete snapshots, and set how often a folder is backed up.

Runs a small local web server for the page in explorer/, fetching from kopia as you browse. Diffs and
folder listings never change for a given snapshot, so they're cached on disk, in kopia-explorer in the
temp folder (TEMP).

Example:
    py kopia_explorer.py
    py kopia_explorer.py --port 9000 --no-browser
"""

import argparse
import itertools
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import tkinter
import traceback
import webbrowser
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tkinter import filedialog, messagebox
from urllib.parse import parse_qs, urlparse

from snapshot_diff import ADDED, MODIFIED, REMOVED, KopiaIgnore, diff_snapshots, kopia, list_snapshots

PAGE_DIR = Path(__file__).parent / 'explorer'
# In the temp folder, as it can be thrown away and can get big
CACHE_DIR = Path(tempfile.gettempdir()) / 'kopia-explorer'
SYMBOL = {ADDED: '+', REMOVED: '-', MODIFIED: '~'}

pool = ThreadPoolExecutor(max_workers=8)


class DiskCache:
    """JSON values on disk, one file per key, for things that never change once known. Each is worked out
    once at a time, as several requests can want the same one together."""

    def __init__(self, folder):
        self.folder = CACHE_DIR / folder
        self.folder.mkdir(parents=True, exist_ok=True)
        self.locks = {}
        self.locks_lock = threading.Lock()

    def get(self, key, compute):
        path = self.folder / f'{key}.json'
        if path.exists():
            return self.read(path)
        with self.locks_lock:
            lock = self.locks.setdefault(key, threading.Lock())
        with lock:
            # Another request may have worked it out while this one waited
            if path.exists():
                return self.read(path)
            value = compute()
            # Written to a temporary file of its own first, so a half-written file is never read back
            partial = path.with_name(f'{key}.{threading.get_ident()}.tmp')
            partial.write_text(json.dumps(value, separators=(',', ':')), encoding='utf-8')
            self.replace(partial, path)
        with self.locks_lock:
            self.locks.pop(key, None)
        return value

    @staticmethod
    def read(path):
        # Windows won't open a file while it's being replaced, so that's given a moment
        for attempt in range(5):
            try:
                return json.loads(path.read_text(encoding='utf-8'))
            except PermissionError:
                time.sleep(0.05 * (attempt + 1))
        return json.loads(path.read_text(encoding='utf-8'))

    @staticmethod
    def replace(partial, path):
        # Windows won't replace a file while it's being read, so that's given a moment too
        for attempt in range(5):
            try:
                return partial.replace(path)
            except PermissionError:
                time.sleep(0.05 * (attempt + 1))
        # Still in use: it's already there, so this copy isn't needed
        partial.unlink(missing_ok=True)


diff_cache = DiskCache('diffs')
listing_cache = DiskCache('listings')
dates_cache = DiskCache('dates')


class Repository:
    """The repository's snapshots, kept up to date, with storage stats recalculated only for sources
    that have new snapshots, in the background, as those take a while."""

    def __init__(self):
        self.lock = threading.Lock()
        self.stats_path = CACHE_DIR / 'storage.json'
        self.stats = json.loads(self.stats_path.read_text(encoding='utf-8')) if self.stats_path.exists() else {}
        self.stats_thread = None
        self.sources = set()  # Every backup location's path
        self.snapshots = {}   # id -> kopia's snapshot JSON, for diffs and downloads
        self.ignores = {}     # source -> its ignore rules, read once
        self.progress = {}    # How working out storage stats is getting on, for the page to show
        status = json.loads(kopia('repository', 'status', '--json'))
        self.info = {
            'description': status['clientOptions'].get('description', ''),
            'path': status['storage'].get('config', {}).get('path', ''),
            'host': status['clientOptions'].get('hostname', ''),
            'user': status['clientOptions'].get('username', ''),
        }

    def storage(self):
        """Every source with its snapshots, oldest first, as the page wants them, straight away. Storage stats
        are whatever's known so far: for sources with new snapshots they're worked out in the background, and
        until then, new snapshots have none. 'working' says whether that's going on, to ask again after."""
        with self.lock:
            # When they were read, so the page knows which backups and deletes since then it still has to apply
            read = time.time()
            snapshots = list_snapshots(include_incomplete=True)
            by_source = {}
            for snap in snapshots:
                by_source.setdefault(snap['source']['path'], []).append(snap)
                self.snapshots[snap['id']] = snap
            # Folders with a policy of their own are backup locations too, as kopia's scheduler backs them up,
            # even before their first snapshot, which they don't have yet
            prefix = policy_key('')
            for key in json.loads(kopia('policy', 'export')):
                if key.startswith(prefix):
                    by_source.setdefault(key[len(prefix):], [])
            self.sources = set(by_source)
            for source in [s for s in self.stats if s not in by_source]:
                del self.stats[source]

            # Storage stats depend on every snapshot of a source, so they're redone when its snapshots change
            ids = {source: sorted(s['id'] for s in snaps) for source, snaps in by_source.items()}
            stale = [source for source in by_source if ids[source] and ids[source] != self.stats.get(source, {}).get('ids')]
            if stale and not self.working():
                self.stats_thread = threading.Thread(target=self.work_out_stats, args=({s: ids[s] for s in stale},), daemon=True)
                self.stats_thread.start()

            result = []
            for source, snaps in sorted(by_source.items(), key=lambda item: item[0].casefold()):
                snaps.sort(key=lambda s: s['startTime'])
                stats = self.stats.get(source, {}).get('stats', {})
                result.append({'path': source, 'host': self.info['host'], 'user': self.info['user'],
                               'snapshots': [snapshot_info(s, stats.get(s['id'])) for s in snaps]})
            return {'repository': self.info, 'locations': result, 'read': read, 'working': self.working()}

    def working(self):
        return bool(self.stats_thread and self.stats_thread.is_alive())

    def work_out_stats(self, stale):
        """Storage stats for sources whose snapshots have changed, given with their snapshot IDs, several at once."""
        print(f'Working out storage for {len(stale)} source(s)...', flush=True)
        started = time.time()
        self.progress = {'step': 'Working out storage', 'done': 0, 'total': len(stale)}
        try:
            futures = {pool.submit(source_stats, source): source for source in stale}
            for future in as_completed(futures):
                source = futures[future]
                try:
                    self.stats[source] = {'ids': stale[source], 'stats': future.result()}
                except Exception as e:
                    print(f'  {source}: {kopia_reason(e)}', flush=True)
                self.progress['done'] += 1
            self.stats_path.write_text(json.dumps(dict(self.stats), separators=(',', ':')), encoding='utf-8')
            print(f'  done in {time.time() - started:.0f}s', flush=True)
        finally:
            self.progress = {}

    def ignore(self, source):
        """The ignore rules for a source, from its policy and the .kopiaignore files on disk, read once
        while the server runs."""
        if source not in self.ignores:
            policy = pool.submit(lambda: json.loads(kopia('policy', 'show', source, '--json')))
            self.ignores.setdefault(source, KopiaIgnore(source, policy))
        return self.ignores[source]


def source_stats(source):
    """Storage stats for each snapshot of a source, by snapshot ID."""
    snapshots = list_snapshots(source, '--storage-stats', include_incomplete=True)
    return {s['id']: s.get('storageStats') or {} for s in snapshots if s['source']['path'] == source}


def snapshot_info(snap, stats):
    """What the page wants to know about a snapshot. Without storage stats, as they're still being worked out,
    what it added on disk and the running total are None."""
    new = (stats or {}).get('newData') or {}
    complete = not snap.get('incomplete')
    unknown = stats is None
    return {
        'id': snap['id'],
        'root': snap['rootEntry']['obj'],
        'mtime': snap['rootEntry'].get('mtime'),
        'time': snap['startTime'],
        # Why it's incomplete, such as canceled, or a checkpoint of one still going
        'incomplete': snap.get('incomplete') or False,
        'size': snap['rootEntry'].get('summ', {}).get('size', 0) if complete else None,
        'files': snap['rootEntry'].get('summ', {}).get('files', 0) if complete else None,
        'newFiles': None if unknown else new.get('fileObjects', 0),
        'newData': None if unknown else new.get('originalContentBytes', 0),
        'onDisk': None if unknown else new.get('packedContentBytes', 0),
        'total': None if unknown else (stats.get('runningTotal') or {}).get('packedContentBytes', 0),
        # Why kopia's retention policy keeps it, such as latest-1 or daily-3
        'keep': snap.get('retentionReason') or [],
    }


repository = Repository()


def raw_diff(old_id, new_id):
    """Every change between two snapshots of a source, cached; ignore rules are applied when served."""
    def compute():
        old, new = repository.snapshots[old_id], repository.snapshots[new_id]
        changes = []
        for kind, path, old_entry, new_entry in diff_snapshots(old, new, [], 0):
            entry = new_entry or old_entry
            item = {'k': SYMBOL[kind], 'p': path}
            if entry['type'] == 'd':
                item.update(d=1, s=entry['summ']['size'], f=entry['summ']['files'])
            else:
                item['s'] = entry.get('size')
                if kind == MODIFIED:
                    item['o'] = old_entry.get('size')
            changes.append(item)
        return changes
    return diff_cache.get(f'{old_id}-{new_id}', compute)


def served_diff(old_id, new_id):
    """A diff with removals that kopia's current ignore rules explain marked as ignored (i), as the files were
    most likely left out of backups from then on rather than deleted, with the rule that did it: its line and
    the ignore file it's in (None for the policy)."""
    source = repository.snapshots[new_id]['source']['path']
    ignore = repository.ignore(source)
    changes = []
    for change in raw_diff(old_id, new_id):
        parts, is_dir = change['p'].rstrip('/').split('/'), change['p'].endswith('/')
        if change['k'] == '-' and ignore.ignored(parts, is_dir):
            rule, origin = ignore.why(parts, is_dir)
            change = {**change, 'k': 'i', 'why': {'rule': rule, 'file': origin}}
        changes.append(change)
    return changes


DATES_DIFFER = re.compile(r'^\.(?:/(.*?))? modification times differ:')


def date_changes(old_id, new_id):
    """Files whose modified date changed between two snapshots but not their contents, cached. kopia's diff
    counts these, and names the folders whose dates differ, without naming the files, so only those folders'
    listings are compared, and none at all when it counts none."""
    def compute():
        old_root = repository.snapshots[old_id]['rootEntry']['obj']
        new_root = repository.snapshots[new_id]['rootEntry']['obj']
        if old_root == new_root:
            return []
        output = kopia('diff', old_root, new_root).splitlines()
        stats = next((json.loads(line) for line in reversed(output) if line.startswith('{')), {})
        if not stats.get('fileEntries', {}).get('sameContentButDifferentModificationTime'):
            return []
        # The folders named, and the ones they're in, as a named one may be a file's folder or the file itself
        named = {match.group(1) or '' for line in output if (match := DATES_DIFFER.match(line))}
        folders = {''} | named | {path.rsplit('/', 1)[0] if '/' in path else '' for path in named}
        content = {change['p'] for change in raw_diff(old_id, new_id)}

        def folder_obj(root, path):
            obj = root
            for part in path.split('/') if path else []:
                entry = next((e for e in listing(obj) if e['n'] == part and e['t'] == 'd'), None)
                if not entry:
                    return None
                obj = entry['o']
            return obj

        def files_in(path):
            before, after = folder_obj(old_root, path), folder_obj(new_root, path)
            if not before or not after or before == after:
                return []
            was = {e['n']: e for e in listing(before) if e['t'] == 'f'}
            prefix = f'{path}/' if path else ''
            # kopia leaves out the size of an empty file
            return [{'k': 'd', 'p': prefix + e['n'], 's': e['s'] or 0, 'from': was[e['n']]['m'], 'to': e['m']}
                    for e in listing(after)
                    if e['t'] == 'f' and e['n'] in was and was[e['n']]['m'] != e['m'] and prefix + e['n'] not in content]
        return sorted((f for found in pool.map(files_in, sorted(folders)) for f in found), key=lambda f: f['p'])
    return dates_cache.get(f'{old_id}-{new_id}', compute)


def listing(obj):
    """A folder's entries, by its object ID, cached."""
    def compute():
        result = []
        for e in json.loads(kopia('show', obj)).get('entries') or []:
            item = {'n': e['name'], 't': 'd' if e['type'] == 'd' else 'f', 'm': e.get('mtime')}
            if item['t'] == 'd':
                item.update(s=e.get('summ', {}).get('size', 0), f=e.get('summ', {}).get('files', 0), o=e['obj'])
            else:
                item['s'] = e.get('size')
            result.append(item)
        return result
    return listing_cache.get(obj, compute)


class Dialogs:
    """Folder pickers and questions, all from one thread kept for them: tkinter isn't reliable when used
    from a different thread each time, which left later pickers never appearing."""

    def __init__(self):
        self.requests = queue.Queue()
        self.thread = None

    def ask(self, show):
        """Run show(root) on the dialog thread, wait for it, and return what it returns."""
        if not self.thread:
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()
        answer = Future()
        self.requests.put((show, answer))
        return answer.result()

    def run(self):
        # The dialogs come from the server, so they go on top, or they'd open behind the browser
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        while True:
            show, answer = self.requests.get()
            try:
                root.lift()
                root.update()
                answer.set_result(show(root))
            except Exception as e:
                answer.set_exception(e)


dialogs = Dialogs()
restored = set()               # Paths restored, which are the only ones the page may show in Explorer
jobs = {}                        # Every restore, backup and delete since the server started, by ID, for the page to follow
job_ids = itertools.count(1)
backup_processes = {}            # Backups still running, by job ID, so they can be cancelled
PROGRESS = re.compile(r'Processed (\d+) \(([\d.]+) (\w+)\) of (\d+) \(([\d.]+) (\w+)\)')
UNITS = {'B': 1, 'KB': 1e3, 'MB': 1e6, 'GB': 1e9, 'TB': 1e12, 'KiB': 1024, 'MiB': 1024 ** 2, 'GiB': 1024 ** 3, 'TiB': 1024 ** 4}
# The parts of kopia's backup progress line, such as
# " * 3 hashing, 120 hashed (1.2 GB), 4000 cached (30 GB), uploaded 1.1 GB, estimated 40 GB (78.0%) 1m30s left"
BACKUP_PROGRESS = {
    'hashed': re.compile(r'(\d+) hashed \(([\d.]+) (\w+)\)'),
    'cached': re.compile(r'(\d+) cached \(([\d.]+) (\w+)\)'),
    'uploaded': re.compile(r'uploaded ([\d.]+) (\w+)'),
    'estimated': re.compile(r'estimated ([\d.]+) (\w+) \(([\d.]+)%\) (\S+) left'),
    'errors': re.compile(r'\((\d+) (?:fatal errors|errors ignored)\)'),
}


def size_of(number, unit):
    return float(number) * UNITS.get(unit, 1)


class BusyError(Exception):
    """Something has to finish before this can be done."""


def kopia_reason(error):
    """Why a kopia command failed, from its error: the last thing kopia said, after the command line."""
    lines = [line.strip() for line in str(error).strip().splitlines() if line.strip()]
    if len(lines) > 1:
        return lines[-1]
    return f'{lines[0]} (kopia didn\'t say why)' if lines else type(error).__name__


def start_restore(snapshot_id, path, is_folder):
    """Restore a file or folder from a snapshot in the background, returning its progress record."""
    snap = repository.snapshots[snapshot_id]
    if being_deleted(snapshot_id):
        raise BusyError('That snapshot is being deleted')
    # One at a time while choosing where, so clicks don't queue up folder pickers behind one another
    choosing = next((j for j in jobs.values() if j['state'] == 'picking'), None)
    if choosing:
        raise BusyError(f'Finish choosing where to restore {choosing["name"]} first')
    source = Path(snap['source']['path'])
    job = {
        'id': next(job_ids), 'kind': 'restore', 'name': path.rsplit('/', 1)[-1] if path else source.name,
        'from': str(source / path) if path else str(source), 'snapshotTime': snap['startTime'],
        'state': 'picking', 'target': None, 'files': 0, 'totalFiles': None, 'bytes': 0, 'totalBytes': None,
        'error': None, 'started': time.time(), 'finished': None,
    }
    jobs[job['id']] = job
    threading.Thread(target=run_restore, args=(job, snap, path, is_folder), daemon=True).start()
    return job


def run_restore(job, snap, path, is_folder):
    """Pick where a restore goes, then run it, straight from kopia so it keeps its modified times and
    attributes, following kopia's progress. It's restored under a temporary name next to where it's going,
    so something half restored is never mistaken for the real thing, then moved into place once complete."""
    working = None
    try:
        source = f'{snap["rootEntry"]["obj"]}/{path}' if path else snap['rootEntry']['obj']
        # Make sure kopia can get at it before asking where to put it, so it fails straight away if not
        kopia('ls', source.rsplit('/', 1)[0] if path else source)
        target = pick_restore_target(snap, path, job['name'], is_folder)
        if not target:
            job['state'] = 'cancelled'
            return
        working = target.with_name(f'{target.name}.kopia-restoring')
        if working.exists():
            working = target.with_name(f'{target.name}.kopia-restoring-{job["id"]}')
        job.update(state='restoring', target=str(target), working=str(working))
        # Progress lines end in carriage returns, which text mode reads as line ends
        process = subprocess.Popen(['kopia', 'restore', '--progress', source, str(working)], stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
        last = ''
        for line in process.stdout:
            if match := PROGRESS.search(line):
                files, size, unit, total_files, total, total_unit = match.groups()
                job.update(files=min(int(files), int(total_files)), totalFiles=int(total_files),
                           bytes=min(size_of(size, unit), size_of(total, total_unit)), totalBytes=size_of(total, total_unit))
            elif line.strip():
                last = line.strip()
        if process.wait():
            raise RuntimeError(last or f'kopia restore failed with exit code {process.returncode}')
        # Complete, so it can't be half done any more: what's left is moving it into place
        job.update(state='finishing', files=job['totalFiles'] or job['files'], bytes=job['totalBytes'] or job['bytes'])
        finished, working = working, None
        move_into_place(finished, target)
        job['state'] = 'done'
        restored.add(str(target))
    except Exception as e:
        # Restored completely but not moved into place, it's kept, so say where it is
        kept = f' (it\'s fully restored as {job["working"]})' if job['state'] == 'finishing' else ''
        job.update(state='failed', error=kopia_reason(e) + kept)
        # A partial restore is no use, so it isn't left behind
        if working and working.exists():
            shutil.rmtree(working) if working.is_dir() else working.unlink()
    finally:
        job['finished'] = time.time()


def move_into_place(finished, target):
    """Move a completed restore to where it was going. A file replaces one already there in one step. A folder
    restored over an existing one has its files moved in, replacing those with the same names, and its folders'
    modified times put back, as moving things into a folder changes them."""
    if not target.exists() or target.is_file():
        os.replace(finished, target)
        return
    folders = []
    for folder, _, files in os.walk(finished):
        inside = target / Path(folder).relative_to(finished)
        inside.mkdir(exist_ok=True)
        # Its times as restored, before moving its files out changes them
        times = Path(folder).stat()
        folders.append((inside, (times.st_atime, times.st_mtime)))
        for name in files:
            os.replace(Path(folder) / name, inside / name)
    # Deepest first, as setting a folder's times doesn't change its parent's
    for inside, times in reversed(folders):
        os.utime(inside, times)
    shutil.rmtree(finished)


def pick_restore_target(snap, path, name, is_folder):
    """Where to restore to, starting where it came from. A file gets a Save As dialog, so it can be renamed,
    and Windows asks before replacing one. A folder gets a folder picker, then if there's one of that name
    already, whether to restore over it or keep both. None if cancelled."""
    source = Path(snap['source']['path'])
    original = (source / path).parent if path else source.parent
    start = str(original) if original.is_dir() else None

    def show(root):
        if not is_folder:
            picked = filedialog.asksaveasfilename(parent=root, title=f'Restore {name} as...', initialdir=start,
                                                  initialfile=name, filetypes=[('All files', '*.*')])
            return Path(picked) if picked else None
        picked = filedialog.askdirectory(parent=root, title=f'Restore {name} to...', mustexist=True, initialdir=start)
        if not picked:
            return None
        target = Path(picked) / name
        if target.exists():
            when = datetime.fromisoformat(snap['startTime'][:19] + '+00:00').astimezone()
            both = target.with_name(f'{target.name} (restored {when:%Y-%m-%d %H%M})')
            answer = messagebox.askyesnocancel('Restore', f'{name} already exists in {picked}.\n\n'
                                               'Yes: restore over it, replacing files with the same names\n'
                                               f'No: keep both, restoring it as {both.name}\n'
                                               'Cancel: don\'t restore', parent=root)
            if answer is None:
                return None
            if not answer:
                target = both
        return target
    return dialogs.ask(show)


def inside_location(path):
    """Whether a path is a backup location or inside one, tidied first so .. can't step out of one. Not
    resolved, as that turns mapped network drives like S: into \\\\server\\share paths, which then aren't inside
    the S: backup locations."""
    target = Path(os.path.abspath(path))
    return any(target == Path(source) or Path(source) in target.parents for source in repository.sources)


def start_backup(source):
    """Take a snapshot of a backup location now, in the background, returning its progress record. kopia
    applies the location's policy as it would for a scheduled one, including expiring old snapshots after. Any
    other folder can be backed up too, which makes it a location of its own."""
    if source not in repository.sources and not os.path.isdir(source):
        raise ValueError(f'There\'s no folder {source}')
    running = next((j for j in jobs.values() if j['kind'] == 'backup' and j['source'] == source and not j['finished']), None)
    if running:
        raise BusyError(f'{source} is already being backed up')
    job = {
        'id': next(job_ids), 'kind': 'backup', 'name': source, 'source': source, 'state': 'running',
        'files': 0, 'bytes': 0, 'uploaded': 0, 'estimated': None, 'percent': None, 'left': None, 'errors': 0,
        'snapshot': None, 'error': None, 'started': time.time(), 'finished': None,
    }
    # In a process group of its own, so it can be sent Ctrl+Break to cancel it without stopping this server
    process = subprocess.Popen(['kopia', 'snapshot', 'create', '--progress', '--json', source], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                               creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    backup_processes[job['id']] = process
    jobs[job['id']] = job
    threading.Thread(target=run_backup, args=(job, process), daemon=True).start()
    return job


def run_backup(job, process):
    """Follow a backup's progress until it ends: complete, cancelled, or failed. Progress lines end in carriage
    returns, which text mode reads as line ends, and the snapshot made comes last, as JSON."""
    result, last = None, ''
    try:
        for line in process.stdout:
            line = line.strip()
            if line.startswith('{'):
                result = json.loads(line)
            elif 'hashing,' in line:
                found = {key: pattern.search(line) for key, pattern in BACKUP_PROGRESS.items()}
                hashed, cached = found['hashed'], found['cached']
                if hashed and cached:
                    job.update(files=int(hashed[1]) + int(cached[1]),
                               bytes=size_of(*hashed.groups()[1:]) + size_of(*cached.groups()[1:]))
                if found['uploaded']:
                    job['uploaded'] = size_of(*found['uploaded'].groups())
                if estimated := found['estimated']:
                    job.update(estimated=size_of(estimated[1], estimated[2]), percent=float(estimated[3]), left=estimated[4])
                job['errors'] = sum(int(count) for count in BACKUP_PROGRESS['errors'].findall(line))
            elif line and not line.startswith('Snapshotting '):
                last = line
        if process.wait() or not result:
            raise RuntimeError(last or f'kopia snapshot create failed with exit code {process.returncode}')
        job['snapshot'] = result['id']
        # Known straight away, so it can be browsed, and the page can show it, before the snapshots are read
        # again, which waits on storage stats; those aren't known yet
        repository.snapshots[result['id']] = result
        job['info'] = snapshot_info(result, None)
        summary = result['rootEntry'].get('summ', {})
        job.update(files=summary.get('files', job['files']), bytes=summary.get('size', job['bytes']),
                   errors=summary.get('numFailed', 0))
        if not result.get('incomplete'):
            job.update(state='done', percent=100, left=None)
        elif job['state'] == 'cancelling':
            job['state'] = 'cancelled'
        else:
            job.update(state='failed', error=f'It stopped before finishing ({result["incomplete"]})')
    except Exception as e:
        job.update(state='failed', error=kopia_reason(e))
    finally:
        backup_processes.pop(job['id'], None)
        job['finished'] = time.time()


def cancel_backup(job_id):
    """Ask a backup to stop, as Ctrl+C would: kopia saves what it got through as an incomplete snapshot, so
    nothing uploaded so far has to be uploaded again. If it hasn't stopped after a minute, it's ended outright."""
    job = jobs[job_id]
    process = backup_processes.get(job_id)
    if process and job['state'] == 'running':
        job['state'] = 'cancelling'
        process.send_signal(signal.CTRL_BREAK_EVENT)
        timer = threading.Timer(60, lambda: process.poll() is None and process.kill())
        timer.daemon = True
        timer.start()
    return job


def policy_key(path):
    return f'{repository.info["user"]}@{repository.info["host"]}:{path}'


def schedule_of(path):
    """How often a folder is backed up on its own, as kopia works it out: from its own policy, or the nearest
    folder above with one, or the user's, the computer's or the global policy, each setting from the first
    that has it. Says where the interval came from, whether the folder has its own, and what it would be
    without it."""
    policies = json.loads(kopia('policy', 'export'))
    user, host = repository.info['user'], repository.info['host']
    folder = Path(path)
    chain = [(policy_key(p), str(p)) for p in [folder, *folder.parents]]
    chain += [(f'{user}@{host}', f'{user}@{host}'), (f'@{host}', host), ('(global)', 'the global policy')]

    def settings(chain):
        found = {}
        for key, name in chain:
            scheduling = (policies.get(key) or {}).get('scheduling') or {}
            for setting in ('intervalSeconds', 'timeOfDay', 'cron', 'manual'):
                if setting in scheduling and setting not in found:
                    found[setting] = (scheduling[setting], name)
        return found

    found, above = settings(chain), settings(chain[1:])
    interval, source = found.get('intervalSeconds', (None, None))
    return {
        'path': path, 'interval': interval, 'from': None if source == str(folder) else source,
        'times': [f'{t["hour"]:02}:{t["min"]:02}' for t in found.get('timeOfDay', ([], None))[0]],
        'cron': found.get('cron', ([], None))[0], 'manual': found.get('manual', (False, None))[0],
        'own': 'intervalSeconds' in ((policies.get(policy_key(folder)) or {}).get('scheduling') or {}),
        'inherited': dict(zip(('interval', 'from'), above.get('intervalSeconds', (None, None)))),
    }


def set_schedule(path, interval):
    """Back a folder up every so often on its own, or with no interval, as the policy above it says. Only its
    own policy's schedule changes: it's exported, changed and imported back, as kopia's policy set can't put an
    interval back to inherited. Any folder on the PC can have one, which makes it a backup location: kopia's
    scheduler backs up folders with a policy of their own."""
    # Tidied, so the same folder typed differently is the same location
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        raise ValueError(f'There\'s no folder {path}')
    # Whole minutes, and no more often than KopiaUI offers
    if interval is not None and (not isinstance(interval, int) or interval < 600 or interval % 60):
        raise KeyError(interval)
    key = policy_key(path)
    policy = json.loads(kopia('policy', 'export')).get(key) or {}
    scheduling = policy.setdefault('scheduling', {})
    if interval is None:
        scheduling.pop('intervalSeconds', None)
    else:
        # Backed up on a schedule, so not only by hand
        scheduling.update(intervalSeconds=interval)
        scheduling.pop('manual', None)
    result = subprocess.run(['kopia', 'policy', 'import', key], input=json.dumps({key: policy}), text=True,
                            encoding='utf-8', capture_output=True)
    if result.returncode:
        raise RuntimeError(f'kopia policy import failed:\n{result.stderr.strip()}')
    return schedule_of(path)


def being_deleted(snapshot_id):
    return any(j['kind'] == 'delete' and j['snapshot'] == snapshot_id and not j['finished'] for j in jobs.values())


def start_delete(snapshot_id):
    """Delete a snapshot from the repository for good, in the background, returning its progress record. Not one
    still being made, which kopia replaces as it goes; a cancelled one is fine. Only the snapshot's record goes, so
    a restore already running from it carries on: its data stays until kopia's maintenance finds nothing uses it."""
    snap = repository.snapshots[snapshot_id]
    if snap.get('incomplete') and snap['incomplete'] != 'canceled':
        raise BusyError('That snapshot is still being made')
    if being_deleted(snapshot_id):
        raise BusyError('That snapshot is already being deleted')
    job = {
        'id': next(job_ids), 'kind': 'delete', 'name': snap['source']['path'], 'source': snap['source']['path'],
        'snapshot': snapshot_id, 'snapshotTime': snap['startTime'], 'state': 'deleting', 'error': None,
        'started': time.time(), 'finished': None,
    }
    jobs[job['id']] = job
    threading.Thread(target=run_delete, args=(job,), daemon=True).start()
    return job


def run_delete(job):
    try:
        kopia('snapshot', 'delete', job['snapshot'], '--delete')
        repository.snapshots.pop(job['snapshot'], None)
        job['state'] = 'done'
    except Exception as e:
        job.update(state='failed', error=kopia_reason(e))
    finally:
        job['finished'] = time.time()


def pick_folder():
    """A folder to back up, picked in a folder picker, or None if cancelled."""
    def show(root):
        picked = filedialog.askdirectory(parent=root, title='Back up a folder', mustexist=True)
        return os.path.abspath(picked) if picked else None
    return {'path': dialogs.ask(show)}


def reveal(path):
    """Show something in Windows Explorer: a folder opened, or a file selected in its folder. If it's gone,
    the nearest folder above it that's still there. Only for things restored or inside a backup location."""
    target = Path(os.path.abspath(path))
    if path not in restored and not inside_location(path):
        raise PermissionError('Only things restored or in a backup location can be shown')
    if target.is_dir():
        subprocess.Popen(['explorer', str(target)])
    elif target.exists():
        subprocess.Popen(f'explorer /select,"{target}"')
    else:
        target = next(p for p in target.parents if p.is_dir())
        subprocess.Popen(['explorer', str(target)])
    return {'shown': str(target)}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        try:
            if url.path in ('/', '/index.html'):
                return self.send_file(PAGE_DIR / 'index.html', 'text/html; charset=utf-8')
            if url.path == '/api/storage':
                return self.send_json(repository.storage())
            if url.path == '/api/progress':
                return self.send_json(repository.progress)
            if url.path == '/api/diff':
                return self.send_json(served_diff(query['from'], query['to']))
            if url.path == '/api/dates':
                return self.send_json(date_changes(query['from'], query['to']))
            if url.path == '/api/listing':
                return self.send_json(listing(query['obj']))
            if url.path == '/api/schedule':
                return self.send_json(schedule_of(query['path']))
            if url.path == '/api/jobs':
                return self.send_json(sorted(jobs.values(), key=lambda j: j['id']))
            if url.path == '/mock-data.js':
                # Empty, so the page knows it's talking to the server, without an error in the console
                return self.send_body(b'', 'text/javascript')
            self.send_error(404)
        except KeyError as e:
            self.send_error(400, f'Missing or unknown {e}')
        except RuntimeError as e:
            self.send_error(502, kopia_reason(e))
        except Exception as e:
            traceback.print_exc()
            self.send_error(500, f'{type(e).__name__}: {e}')

    def do_POST(self):
        # Only the explorer's own page sends this header: a web page elsewhere can't without the browser
        # asking first, which this server never allows, so other sites can't make it restore, back up or delete anything
        if self.headers.get('X-Kopia-Explorer') != '1':
            return self.send_error(403, 'Only the explorer page can do that')
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            if self.path == '/api/restore':
                return self.send_json(start_restore(body['snapshot'], body['path'], bool(body.get('folder'))))
            if self.path == '/api/backup':
                return self.send_json(start_backup(body['source']))
            if self.path == '/api/backup/cancel':
                return self.send_json(cancel_backup(body['id']))
            if self.path == '/api/schedule':
                return self.send_json(set_schedule(body['path'], body['interval']))
            if self.path == '/api/pick-folder':
                return self.send_json(pick_folder())
            if self.path == '/api/snapshot/delete':
                return self.send_json(start_delete(body['id']))
            if self.path == '/api/jobs/clear':
                for job in [j for j in jobs.values() if j['finished']]:
                    del jobs[job['id']]
                return self.send_json({})
            if self.path == '/api/reveal':
                return self.send_json(reveal(body['path']))
            self.send_error(404)
        except KeyError as e:
            self.send_error(400, f'Missing or unknown {e}')
        except ValueError as e:
            self.send_error(400, str(e))
        except RuntimeError as e:
            self.send_error(502, kopia_reason(e))
        except PermissionError as e:
            self.send_error(403, str(e))
        except BusyError as e:
            self.send_error(409, str(e))
        except Exception as e:
            traceback.print_exc()
            self.send_error(500, f'{type(e).__name__}: {e}')

    def send_error(self, code, message=None, explain=None):
        # The page shows the message, which goes in the status line, so it has to fit in Latin-1 on one line
        if message:
            message = ' '.join(message.split()).encode('latin-1', 'replace').decode('latin-1')
        super().send_error(code, message, explain)

    def send_json(self, value):
        self.send_body(json.dumps(value, separators=(',', ':')).encode('utf-8'), 'application/json')

    def send_file(self, path, content_type):
        self.send_body(path.read_bytes(), content_type)

    def send_body(self, body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Only errors are worth printing, with their reason, but not browsers looking for icons that aren't there
        if format.startswith('code ') and args[0] != 404:
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description='Browse kopia snapshots in a web page.')
    parser.add_argument('--port', type=int, default=8765, help='port to serve on (default: 8765)')
    parser.add_argument('--no-browser', action='store_true', help="don't open the page in a browser")
    args = parser.parse_args()

    print('Reading the repository...', flush=True)
    repository.storage()

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://localhost:{args.port}/'
    print(f'Kopia Explorer is at {url} (Ctrl+C to stop)', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        pool.shutdown(wait=False, cancel_futures=True)
        # Backups would carry on without anything following them, so they're stopped, saving what they got through
        for job_id, process in list(backup_processes.items()):
            print(f'Cancelling the backup of {jobs[job_id]["source"]}...', flush=True)
            cancel_backup(job_id)
            try:
                process.wait(60)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        raise SystemExit(str(e))
