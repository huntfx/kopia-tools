"""Browse kopia snapshots in a window of their own: backup locations, their snapshots, folder contents and file types, what
changed between snapshots, and file histories, restore files and folders from any snapshot, back up a location
now, delete snapshots, and set how often a folder is backed up.

Runs a small local web server for the page in explorer/ (index.html, style.css and the modules in js/),
fetching from kopia as you browse, and shows it in a window with pywebview (py -m pip install pywebview), or in a
browser. Diffs and folder listings never change for a given snapshot, so they're cached on disk, in
kopia-explorer in the temp folder (TEMP).

Example:
    py kopia_explorer.py
    py kopia_explorer.py --browser
    py kopia_explorer.py --port 9000 --no-browser
    py kopia_explorer.py --quiet
"""

import argparse
import ctypes
import hashlib
import itertools
import json
import logging
import os
import queue
import re
import shutil
import signal
import sqlite3
import string
import subprocess
import sys
import tempfile
import threading
import time
import tkinter
import traceback
import webbrowser
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor, as_completed
from ctypes import wintypes
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tkinter import filedialog, messagebox
from urllib.parse import parse_qs, urlparse

from kopia_docs import kopia_doc
from snapshot_diff import (ADDED, DIFF_FILE, MODIFIED, REMOVED, KopiaIgnore, diff_snapshots, glob_to_regex, kopia, list_snapshots,
                           log_command, parse_ignore_rule)

PAGE_DIR = Path(__file__).parent / 'explorer'
# In the temp folder, as it can be thrown away and can get big
CACHE_DIR = Path(tempfile.gettempdir()) / 'kopia-explorer'
SYMBOL = {ADDED: '+', REMOVED: '-', MODIFIED: '~'}

pool = ThreadPoolExecutor(max_workers=8)
# Working out storage stats has workers of its own, as each source's can take most of a minute: in the shared
# pool, after a restart with every source to do, they took all its workers, so everything the page asked for
# that needs it waited behind them, and those requests used up the browser's connections to the server, holding
# up even ones that don't, like its progress and the folder picker
stats_pool = ThreadPoolExecutor(max_workers=4)


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
            try:
                partial.write_text(json.dumps(value, separators=(',', ':')), encoding='utf-8')
                self.replace(partial, path)
            except OSError:
                # Such as the disk being full: it's still served, just worked out again next time
                partial.unlink(missing_ok=True)
        with self.locks_lock:
            self.locks.pop(key, None)
        return value

    def rename(self, old, new):
        """For a snapshot saved again under a new ID, such as when it's pinned: what's cached under its old one,
        which is still true of it, moves to its new one."""
        for path in self.folder.glob(f'*{old}*.json'):
            try:
                path.replace(path.with_name(path.name.replace(old, new)))
            except OSError:
                pass

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
# Listings gained folder counts, so they're cached afresh, and the old ones, which can be big, go
shutil.rmtree(CACHE_DIR / 'listings', ignore_errors=True)
listing_cache = DiskCache('listings-2')
dates_cache = DiskCache('dates')


class Repository:
    """The repository's snapshots, kept up to date, with storage stats recalculated only for sources
    that have new snapshots, in the background, as those take a while."""

    def __init__(self):
        self.lock = threading.Lock()
        self.stats_path = CACHE_DIR / 'storage.json'
        # Unreadable, they're just worked out again
        try:
            self.stats = json.loads(self.stats_path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            self.stats = {}
        self.stats_thread = None
        self.sources = set()  # Every backup location's path
        self.actions = None   # What the policies here with snapshot actions are for, or None until they're read
        self.snapshots = {}   # id -> kopia's snapshot JSON, for diffs and downloads
        self.ignores = {}     # source -> its ignore rules, read once
        self.progress = {}    # How working out storage stats is getting on, for the page to show
        self.renames = {}     # old id -> new id, for snapshots pinned or unpinned, for the page to follow them
        self.live = set()     # IDs of checkpoints of backups still going, as of when the snapshots were last read
        self.folded = {}      # id -> IDs of the earlier checkpoints of the same backup shown as it, deleted with it
        self.exported = None  # kopia policy export's output, kept between asks, or None until it's read again
        self.policies_lock = threading.Lock()
        self.info = self.read_info()

    def policies(self, fresh=False):
        """Every policy, by kopia's key for it, as kopia policy export gives them, kept between asks, as reading
        them takes most of a second, such as for each folder opened. Read again when asked for fresh, as before one's
        changed, so nothing changed elsewhere is undone, and after the explorer changes any. Reading the snapshots
        reads them fresh too, so ones changed in KopiaUI are picked up on a refresh. Each ask gets its own copy,
        to change as it likes."""
        with self.policies_lock:
            if fresh or self.exported is None:
                self.exported = kopia('policy', 'export')
            return json.loads(self.exported)

    def policies_changed(self):
        with self.policies_lock:
            self.exported = None

    @staticmethod
    def read_info():
        status = json.loads(kopia('repository', 'status', '--json'))
        return {
            'description': status['clientOptions'].get('description', ''),
            'path': status['storage'].get('config', {}).get('path', ''),
            'host': status['clientOptions'].get('hostname', ''),
            'user': status['clientOptions'].get('username', ''),
        }

    def forget(self):
        """For a hard refresh: what's read once while the server runs is read again, as it may have changed since,
        such as ignore rules in .kopiaignore files, and the repository's description. Diffs, listings and file
        types stay cached, as they never change for a given snapshot."""
        self.ignores.clear()
        self.policies_changed()
        self.info = self.read_info()

    def storage(self):
        """Every source with its snapshots, oldest first, as the page wants them, straight away. Storage stats
        are whatever's known so far: for sources with new snapshots they're worked out in the background, and
        until then, new snapshots have none. 'working' says whether that's going on, to ask again after."""
        with self.lock:
            # When they were read, so the page knows which backups and deletes since then it still has to apply
            read = time.time()
            # The policies are read alongside, as each takes most of a second, mostly kopia opening the repository
            policies = pool.submit(self.policies, fresh=True)
            snapshots = list_snapshots(include_incomplete=True)
            # Last good pins move on to snapshots made since, which saves both again under new IDs
            if moved := self.move_last_good(snapshots):
                snapshots = list_snapshots(include_incomplete=True)
                fresh = {same_snapshot(s): s for s in snapshots}
                for old in moved:
                    if (new := fresh.get(same_snapshot(old))) and new['id'] != old['id']:
                        self.renamed(old['id'], new)
            by_source = {}
            for snap in snapshots:
                by_source.setdefault(snap['source']['path'], []).append(snap)
                self.snapshots[snap['id']] = snap
            # Folders with a policy of their own are backup locations too, as kopia's scheduler backs them up,
            # even before their first snapshot, which they don't have yet
            prefix = policy_key('')
            policies = policies.result()
            for key in policies:
                if key.startswith(prefix):
                    by_source.setdefault(key[len(prefix):], [])
            self.sources = set(by_source)
            self.actions = with_actions(policies)
            for source in [s for s in self.stats if s not in by_source]:
                del self.stats[source]

            # Storage stats depend on every snapshot of a source, so they're redone when its snapshots change
            ids = {source: sorted(s['id'] for s in snaps) for source, snaps in by_source.items()}
            stale = [source for source in by_source if ids[source] and ids[source] != self.stats.get(source, {}).get('ids')]
            if stale and not self.working():
                self.stats_thread = threading.Thread(target=self.work_out_stats, args=({s: ids[s] for s in stale},), daemon=True)
                self.stats_thread.start()

            result = []
            kopias = kopia_started()
            self.live = set()
            self.folded = {}
            for source, snaps in sorted(by_source.items(), key=lambda item: item[0].casefold()):
                # Checkpoints of the same backup share its start, so they're in the order they were saved
                snaps.sort(key=lambda s: (s['startTime'], s.get('endTime') or ''))
                shown, folded = fold_checkpoints(snaps)
                self.folded.update(folded)
                if shown and still_going(shown[-1], kopias, read):
                    self.live.add(shown[-1]['id'])
                stats = self.stats.get(source, {}).get('stats', {})
                result.append({'path': source, 'host': self.info['host'], 'user': self.info['user'],
                               'snapshots': [snapshot_info(s, folded_stats(s['id'], folded, stats), s['id'] in self.live, len(folded.get(s['id'], [])))
                                             for s in shown]})
            return {'repository': self.info, 'locations': result, 'read': read, 'working': self.working(), 'renamed': self.renames}

    def working(self):
        return bool(self.stats_thread and self.stats_thread.is_alive())

    def work_out_stats(self, stale):
        """Storage stats for sources whose snapshots have changed, given with their snapshot IDs, several at once."""
        print(f'Working out storage for {len(stale)} source(s)...', flush=True)
        started = time.time()
        self.progress = {'step': 'Working out storage', 'done': 0, 'total': len(stale)}
        try:
            futures = {stats_pool.submit(source_stats, source): source for source in stale}
            for future in as_completed(futures):
                source = futures[future]
                try:
                    self.stats[source] = {'ids': stale[source], 'stats': future.result()}
                except Exception as e:
                    print(f'  {source}: {kopia_reason(e)}', flush=True)
                self.progress['done'] += 1
            self.save_stats()
            print(f'  done in {time.time() - started:.0f}s', flush=True)
        finally:
            self.progress = {}

    def save_stats(self):
        # Written to a temporary file first, so a full disk can't leave it half written
        partial = self.stats_path.with_suffix('.tmp')
        try:
            partial.write_text(json.dumps(dict(self.stats), separators=(',', ':')), encoding='utf-8')
            DiskCache.replace(partial, self.stats_path)
        except OSError as e:
            partial.unlink(missing_ok=True)
            print(f'  couldn\'t save storage stats: {e}', flush=True)

    def change_pins(self, snapshot_id, add=(), remove=()):
        """Pin a snapshot under names, so kopia's retention policy never deletes it, as KopiaUI does, or take pins
        off it. Kopia saves it again with a new ID, so its storage stats, diffs and dates go with it, as they
        haven't changed, rather than being worked out again. Returns it as the page wants it."""
        with self.lock:
            snap = self.snapshots[snapshot_id]
            pins = snap.get('pins') or []
            add = [p for p in add if p not in pins]
            remove = [p for p in remove if p in pins]
            if not add and not remove:
                fresh = snap
            else:
                kopia('snapshot', 'pin', snapshot_id, *[f'--add={p}' for p in add], *[f'--remove={p}' for p in remove])
                fresh = next(s for s in list_snapshots(snap['source']['path']) if same_snapshot(s) == same_snapshot(snap))
                self.renamed(snapshot_id, fresh)
            stats = self.stats.get(snap['source']['path'], {}).get('stats', {})
            return snapshot_info(fresh, stats.get(fresh['id']))

    def renamed(self, old_id, fresh):
        """A snapshot saved again under a new ID, as pinning or unpinning does: its storage stats, diffs and dates go
        with it, as they haven't changed, rather than being worked out again, and the page is told, to follow it"""
        self.snapshots.pop(old_id, None)
        self.snapshots[fresh['id']] = fresh
        known = self.stats.get(fresh['source']['path'])
        if known and old_id in known['ids']:
            known['ids'] = sorted(fresh['id'] if i == old_id else i for i in known['ids'])
            known['stats'][fresh['id']] = known['stats'].pop(old_id, None) or {}
            self.save_stats()
        for cache in (diff_cache, dates_cache):
            cache.rename(old_id, fresh['id'])
        # Ones renamed before lead to the newest ID
        for old, new in self.renames.items():
            if new == old_id:
                self.renames[old] = fresh['id']
        self.renames[old_id] = fresh['id']

    def move_last_good(self, snapshots):
        """Move each location's last good pin on to its newest good snapshot, when it's newer than the one pinned:
        pinned there first, so it's never without one, then taken off the others. Returns the snapshots pinned or
        unpinned, which kopia has saved again under new IDs."""
        by_source = {}
        for snap in snapshots:
            by_source.setdefault(snap['source']['path'], []).append(snap)
        moved = []
        for source, snaps in by_source.items():
            pinned = [s for s in snaps if LAST_GOOD in (s.get('pins') or [])]
            newest = max((s for s in snaps if is_good(s)), key=lambda s: s['startTime'], default=None)
            if not pinned or not newest or pinned == [newest] or any(s['startTime'] > newest['startTime'] for s in pinned):
                continue
            # Not while the page is pinning or deleting one of them itself
            if any(being_pinned(s['id']) or being_deleted(s['id']) for s in [newest, *pinned]):
                continue
            old = [s for s in pinned if s is not newest]
            try:
                if newest not in pinned:
                    kopia('snapshot', 'pin', newest['id'], f'--add={LAST_GOOD}')
                    moved.append(newest)
                kopia('snapshot', 'pin', *[s['id'] for s in old], f'--remove={LAST_GOOD}')
                moved.extend(old)
                print(f'Moved the last good pin of {source} on to its snapshot of {newest["startTime"]}', flush=True)
            except RuntimeError as e:
                print(f'Couldn\'t move the last good pin of {source}: {kopia_reason(e)}', flush=True)
        return moved

    def ignore(self, source):
        """The ignore rules for a source, from its policy and the .kopiaignore files on disk, read once
        while the server runs."""
        if source not in self.ignores:
            policy = pool.submit(lambda: json.loads(kopia('policy', 'show', source, '--json')))
            self.ignores.setdefault(source, KopiaIgnore(source, policy))
        return self.ignores[source]


# A pin that moves on to each new good snapshot of a location, so its last good one is kept however many
# backups since have had errors, and only until there's a newer one
LAST_GOOD = 'last-good'


def is_good(snap):
    """Whether a snapshot is finished, with everything read"""
    return not snap.get('incomplete') and not snap['rootEntry'].get('summ', {}).get('numFailed', 0)


def same_snapshot(snap):
    """What stays the same when kopia saves a snapshot again under a new ID"""
    return snap['source']['path'], snap['startTime'], snap['rootEntry']['obj']


def source_stats(source):
    """Storage stats for each snapshot of a source, by snapshot ID."""
    snapshots = list_snapshots(source, '--storage-stats', include_incomplete=True)
    return {s['id']: s.get('storageStats') or {} for s in snapshots if s['source']['path'] == source}


# Kopia saves a checkpoint of a backup as it goes, as an incomplete snapshot replacing the one before, at most
# 45 minutes apart. One left behind by a backup that stopped without finishing, as when KopiaUI was closed or
# the computer shut down part way, stays as it is, until a backup finishes and kopia's retention policy tidies it.
CHECKPOINT_EVERY = 45 * 60
# Allowing for one that's taking a while to be saved
CHECKPOINT_SLACK = 15 * 60


def unix_time(timestamp):
    # Kopia uses up to 9 fractional digits; seconds are near enough
    return datetime.fromisoformat(timestamp[:19] + '+00:00').timestamp()


def kopia_started():
    """When each kopia process running started, as Unix times: KopiaUI's server, which makes the scheduled
    snapshots, and any making one at the command line or from here. None if that can't be found out."""
    try:
        return [t for pid, _, name in processes() if name.lower() == 'kopia.exe' and (t := started(pid)) is not None]
    except OSError:
        return None


def still_going(snap, kopias, now):
    """Whether a location's newest snapshot is a checkpoint of a backup still going, rather than one left behind:
    saved recently enough for another to be on its way, by a kopia that's still running, as one started since
    can't be carrying on with it. A location's backups run one at a time, so older checkpoints are all left behind."""
    if snap.get('incomplete') != 'checkpoint':
        return False
    if now - unix_time(snap.get('endTime') or snap['startTime']) > CHECKPOINT_EVERY + CHECKPOINT_SLACK:
        return False
    return kopias is None or any(t <= unix_time(snap['startTime']) for t in kopias)


def fold_checkpoints(snaps):
    """A source's snapshots, oldest first, with the checkpoints kopia saved of each backup as it went, which share
    its start, shown as one: its finished snapshot, if it has one, or else the last it saved, which says how far it
    got. Returns the ones to show, in order, and the IDs of those folded into each, by its ID."""
    by_start = {}
    for snap in snaps:
        by_start.setdefault(snap['startTime'], []).append(snap)
    shown, folded = [], {}
    for group in by_start.values():
        complete = [snap for snap in group if not snap.get('incomplete')]
        kept = complete[-1] if complete else group[-1]
        # Only checkpoints are folded; finished snapshots are each shown, as they never share a start anyway
        earlier = [snap['id'] for snap in group if snap is not kept and snap.get('incomplete')]
        shown += [snap for snap in group if snap is kept or not snap.get('incomplete')]
        if earlier:
            folded[kept['id']] = earlier
    return shown, folded


def folded_stats(snapshot_id, folded, stats):
    """A snapshot's storage stats, with what the checkpoints folded into it added too, so it's what the whole backup
    added, and its running total as at the last; None until they're all known."""
    ids = [*folded.get(snapshot_id, []), snapshot_id]
    if any(stats.get(i) is None for i in ids):
        return None
    if len(ids) == 1:
        return stats[snapshot_id]
    added = {key: sum((stats[i].get('newData') or {}).get(key, 0) for i in ids)
             for key in ('fileObjects', 'originalContentBytes', 'packedContentBytes')}
    return {**stats[snapshot_id], 'newData': added}


def snapshot_info(snap, stats, live=False, checkpoints=0):
    """What the page wants to know about a snapshot. Without storage stats, as they're still being worked out,
    what it added on disk and the running total are None. Live says whether it's a checkpoint of a backup still
    going, and checkpoints how many earlier ones of the same backup it stands for."""
    new = (stats or {}).get('newData') or {}
    complete = not snap.get('incomplete')
    unknown = stats is None
    return {
        'id': snap['id'],
        'root': snap['rootEntry']['obj'],
        'mtime': snap['rootEntry'].get('mtime'),
        'time': snap['startTime'],
        # Why it's incomplete, such as canceled, or a checkpoint, of one still going (live) or left behind
        'incomplete': snap.get('incomplete') or False,
        'live': live,
        'checkpoints': checkpoints,
        'size': snap['rootEntry'].get('summ', {}).get('size', 0) if complete else None,
        'files': snap['rootEntry'].get('summ', {}).get('files', 0) if complete else None,
        # Folders inside it, as kopia counts the folder itself too
        'folders': max(snap['rootEntry'].get('summ', {}).get('dirs', 1) - 1, 0) if complete else None,
        'newFiles': None if unknown else new.get('fileObjects', 0),
        'newData': None if unknown else new.get('originalContentBytes', 0),
        'onDisk': None if unknown else new.get('packedContentBytes', 0),
        'total': None if unknown else (stats.get('runningTotal') or {}).get('packedContentBytes', 0),
        # Why kopia's retention policy keeps it, such as latest-1 or daily-3
        'keep': snap.get('retentionReason') or [],
        # Names it's pinned under, which stop kopia's retention policy deleting it
        'pins': snap.get('pins') or [],
        # Files and folders kopia couldn't read, so left out of it, such as ones another program had open
        'failed': snap['rootEntry'].get('summ', {}).get('numFailed', 0),
        'errors': [{'path': e['path'], 'error': error_reason(e['error'])}
                   for e in snap['rootEntry'].get('summ', {}).get('errors') or []],
    }


def error_reason(error):
    """Why kopia couldn't read something, without what it was doing: the end of the first line of its error, which
    it can repeat hundreds of times, like "The process cannot access the file because it is being used by another
    process." from "error uploading parts: unable to open file: ...: The process cannot access..." """
    first = error.strip().splitlines()[0] if error.strip() else ''
    return first.rsplit(': ', 1)[-1] or first


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
                # Folders inside it (D), as kopia counts the folder itself too
                summ = e.get('summ', {})
                item.update(s=summ.get('size', 0), f=summ.get('files', 0), D=max(summ.get('dirs', 1) - 1, 0), o=e['obj'])
            else:
                item['s'] = e.get('size')
            result.append(item)
        return result
    return listing_cache.get(obj, compute)


class FileTypes:
    """How many files of each type a folder has and how big they are, counting everything inside it:
    { extension: [files, bytes] }, by the folder's object ID, with '' for files without one. A folder with the
    same ID never changes, so they're kept for good. kopia lists a whole tree in one go far faster than folder by
    folder, so each tree listed tallies every folder in it, kept in one SQLite file as there are thousands.
    The same listing keeps what's directly in each folder, its files' names and sizes and the folders in it, so
    the page's filter, counting only files whose paths match, is worked out from those without asking kopia again."""

    def __init__(self):
        self.db = sqlite3.connect(CACHE_DIR / 'types.sqlite', check_same_thread=False)
        # Tallies from before a name starting with a dot, like .gitignore, was its extension are counted again
        if self.db.execute('PRAGMA user_version').fetchone()[0] < 1:
            with self.db:
                self.db.execute('DROP TABLE IF EXISTS tallies')
                self.db.execute('PRAGMA user_version = 1')
        self.db.execute('CREATE TABLE IF NOT EXISTS tallies (obj TEXT PRIMARY KEY, tally TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS folders (obj TEXT PRIMARY KEY, entries TEXT NOT NULL)')
        self.db_lock = threading.Lock()
        self.locks = {}
        self.locks_lock = threading.Lock()
        # A big tree takes kopia a while, so only a couple at once
        self.listing = threading.Semaphore(2)
        # Filtered tallies by folder and filter, for the filters tried lately, which share the folders that didn't
        # change between snapshots, and what's in folders, read back to work them out
        self.filtered = {}
        self.folders = {}
        self.memory_lock = threading.Lock()

    def get(self, obj, patterns=(), path='', base=None):
        """Filtered, path is where the folder is in its location, with / separators, and base is the folder being
        looked at, which patterns look below, the folder itself if not given."""
        # The same patterns in any order or case are the same filter
        key = '\n'.join(sorted({p.lower() for p in patterns}))
        if key:
            self.listed(obj, lambda: self.entries(obj) is not None)
            below = '' if base is None else path[len(base):].strip('/')
            return self.tally_matching(obj, key, name_matcher(key.split('\n')), below)
        # Folders listed before tallies were counted again only need counting from what's in them
        if self.read(obj) is None and self.entries(obj) is not None:
            self.recount(obj)
        self.listed(obj, lambda: self.read(obj) is not None)
        return self.read(obj)

    def inside(self, obj, patterns=(), path=''):
        """Each folder directly inside a folder's tally, by name. Counting the folder tallies everything in it,
        so they're all known by then."""
        self.get(obj, patterns, path)
        return {e['n']: self.get(e['o'], patterns, f'{path}/{e["n"]}' if path else e['n'], path) for e in listing(obj) if e['t'] == 'd'}

    def listed(self, obj, known):
        """Lists the tree a folder is the top of with kopia, unless what's wanted is known already. Once at a
        time, as several requests can want the same one together."""
        if known():
            return
        with self.locks_lock:
            lock = self.locks.setdefault(obj, threading.Lock())
        with lock:
            if not known():
                with self.listing:
                    self.count(obj)
        with self.locks_lock:
            self.locks.pop(obj, None)

    def read(self, obj):
        with self.db_lock:
            row = self.db.execute('SELECT tally FROM tallies WHERE obj = ?', (obj,)).fetchone()
        return json.loads(row[0]) if row else None

    def entries(self, obj):
        """What's directly in a folder: { 'f': [[name, bytes], ...], 'd': [[name, object ID], ...] }"""
        with self.memory_lock:
            found = self.folders.get(obj)
        if found is None:
            with self.db_lock:
                row = self.db.execute('SELECT entries FROM folders WHERE obj = ?', (obj,)).fetchone()
            if row is None:
                return None
            found = json.loads(row[0])
            with self.memory_lock:
                # Roughly bounded, by starting again once there are a lot
                if len(self.folders) > 300_000:
                    self.folders.clear()
                self.folders[obj] = found
        return found

    def tally_matching(self, obj, key, matches, path):
        """Path is where the folder is below the one being looked at"""
        remembered = (obj, key, path)
        with self.memory_lock:
            found = self.filtered.get(remembered)
        if found is not None:
            return found
        entries = self.entries(obj)
        if entries is None:
            self.listed(obj, lambda: self.entries(obj) is not None)
            entries = self.entries(obj)
        tally = {}
        folders = f'/{path}/' if path else '/'
        for name, size in entries['f']:
            if matches(folders + name):
                counts = tally.setdefault(extension_of(name), [0, 0])
                counts[0] += 1
                counts[1] += size
        for name, child in entries['d']:
            for extension, (files, size) in self.tally_matching(child, key, matches, f'{path}/{name}' if path else name).items():
                counts = tally.setdefault(extension, [0, 0])
                counts[0] += files
                counts[1] += size
        with self.memory_lock:
            if len(self.filtered) > 500_000:
                self.filtered.clear()
            self.filtered[remembered] = tally
        return tally

    def recount(self, obj):
        """Tallies a folder and every folder in it from what's in them, as listing it would"""
        rows = []

        def tally(obj):
            counts = {}
            entries = self.entries(obj)
            for name, size in entries['f']:
                found = counts.setdefault(extension_of(name), [0, 0])
                found[0] += 1
                found[1] += size
            for _, child in entries['d']:
                for extension, (files, size) in tally(child).items():
                    found = counts.setdefault(extension, [0, 0])
                    found[0] += files
                    found[1] += size
            rows.append((obj, json.dumps(counts, separators=(',', ':'))))
            return counts
        tally(obj)
        with self.db_lock, self.db:
            self.db.executemany('INSERT OR IGNORE INTO tallies VALUES (?, ?)', rows)

    def count(self, obj):
        # Each folder by its path inside the tree, '' for the tree itself
        tallies, objs, entries = {'': {}}, {'': obj}, {}
        # Lines are: mode, size, date, time, time zone, object ID, path, with a / after a folder's
        for line in kopia('ls', '-r', '-l', '-o', obj).splitlines():
            parts = line.split(None, 6)
            if len(parts) < 7:
                continue
            mode, size, oid, path = parts[0], parts[1], parts[5], parts[6].rstrip('/')
            parent, _, name = path.rpartition('/')
            if mode.startswith('d'):
                objs[path] = oid
                entries.setdefault(parent, {'f': [], 'd': []})['d'].append([name, oid])
                continue
            # Files only, not links
            if not mode.startswith('-'):
                continue
            size = int(size) if size.isdigit() else 0
            entries.setdefault(parent, {'f': [], 'd': []})['f'].append([name, size])
            extension = extension_of(name)
            names = path.split('/')
            for depth in range(len(names)):
                counts = tallies.setdefault('/'.join(names[:depth]), {}).setdefault(extension, [0, 0])
                counts[0] += 1
                counts[1] += size
        # Empty folders have nothing in them to put them in the tallies
        compact = {'separators': (',', ':')}
        rows = [(oid, json.dumps(tallies.get(path, {}), **compact)) for path, oid in objs.items()]
        folders = [(oid, json.dumps(entries.get(path, {'f': [], 'd': []}), **compact)) for path, oid in objs.items()]
        with self.db_lock, self.db:
            self.db.executemany('INSERT OR IGNORE INTO tallies VALUES (?, ?)', rows)
            self.db.executemany('INSERT OR IGNORE INTO folders VALUES (?, ?)', folders)


def extension_of(name):
    # A name starting with a dot, like .gitignore, is all extension
    dot = name.rfind('.')
    return name[dot:].lower() if dot >= 0 else ''


def name_matcher(patterns):
    """Whether a file gets through the page's filter, as the page tests it, from its path below the folder being
    looked at, like /Unreal/Unreal.exe: patterns match anywhere in it, so in the file's name or any folder's,
    ignoring case, with the wildcards of ignore rules, like Unreal/**/*.exe, and / or \\ between names. Those
    starting with one match from the folder being looked at, like /Unreal.exe. Starting with file: they only
    match the file's name, and with a / from its start, and with folder: only the folders it's in. ext: matches
    its extension exactly, like ext:.png, or ext:png, and by itself, files without one. One starting with !
    leaves out what matches the rest of it instead, so a file has to match one of the others, if there are any,
    and none of those."""
    def regexes(found):
        """Each kind's patterns as one regex, by what they're tested on"""
        kinds = {}
        for pattern in found:
            kind, _, pattern = pattern.partition(':') if pattern.lower().startswith(('ext:', 'file:', 'folder:')) else ('', '', pattern)
            pattern = pattern.replace('\\', '/')
            if kind.lower() == 'ext':
                regex = f'^{glob_to_regex("." + pattern.lstrip("."))}$' if pattern else '^$'
            else:
                regex = ('^' if pattern.startswith('/') else '') + glob_to_regex(pattern)
            kinds.setdefault(kind.lower(), []).append(regex)
        return {kind: re.compile('|'.join(found), re.IGNORECASE) for kind, found in kinds.items()}
    include = regexes([p for p in patterns if not p.startswith('!')])
    exclude = regexes([p[1:] for p in patterns if p.startswith('!') and len(p) > 1])

    def matches(path):
        cut = path.rfind('/') + 1
        tested = {'': path, 'file': f'/{path[cut:]}', 'folder': path[:cut], 'ext': extension_of(path[cut:])}
        found = lambda kinds: any(regex.search(tested[kind]) for kind, regex in kinds.items())
        return (not include or found(include)) and not found(exclude)
    return matches


file_types = FileTypes()


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
jobs = {}                        # Every restore, backup, mount, delete and settings change since the server started, by ID, for the page to follow
job_ids = itertools.count(1)
backup_processes = {}            # Backups still running, by job ID, so they can be cancelled
mount_processes = {}             # Folders mounted as drives, by job ID, so they can be unmounted
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
    return f'{lines[0]} (Kopia didn\'t say why)' if lines else type(error).__name__


def start_restore(snapshot_id, path, is_folder, nested=()):
    """Restore a file or folder from a snapshot in the background, returning its progress record. A folder can
    have snapshots of locations nested inside it restored into it too, for the files in them that the folder's
    own snapshot hasn't got, as when they're left out of it to be backed up on their own instead."""
    snap = repository.snapshots[snapshot_id]
    if being_deleted(snapshot_id):
        raise BusyError('That snapshot is being deleted')
    # One at a time while choosing where, so clicks don't queue up folder pickers behind one another
    choosing = next((j for j in jobs.values() if j['state'] == 'picking'), None)
    if choosing:
        raise BusyError(f'Finish choosing where to restore {choosing["name"]} first')
    source = Path(snap['source']['path'])
    folder = source / path if path else source
    inner = []
    for nested_id in nested if is_folder else ():
        inside = repository.snapshots[nested_id]
        if being_deleted(nested_id):
            raise BusyError(f'The snapshot of {inside["source"]["path"]} is being deleted')
        where = Path(inside['source']['path'])
        if folder not in where.parents:
            raise ValueError(f'{where} isn\'t inside {folder}')
        inner.append((inside, where.relative_to(folder)))
    # Shallowest first, so ones nested deeper go into what those restored
    inner.sort(key=lambda i: len(i[1].parts))
    job = {
        'id': next(job_ids), 'kind': 'restore', 'name': path.rsplit('/', 1)[-1] if path else source.name,
        'from': str(folder), 'snapshotTime': snap['startTime'],
        'nested': [{'path': i['source']['path'], 'snapshotTime': i['startTime']} for i, _ in inner], 'part': 0,
        'state': 'picking', 'target': None, 'files': 0, 'totalFiles': None, 'bytes': 0, 'totalBytes': None,
        'error': None, 'started': time.time(), 'finished': None,
    }
    jobs[job['id']] = job
    threading.Thread(target=run_restore, args=(job, snap, path, is_folder, inner), daemon=True).start()
    return job


def run_restore(job, snap, path, is_folder, nested=()):
    """Pick where a restore goes, then run it, straight from kopia so it keeps its modified times and
    attributes, following kopia's progress. It's restored under a temporary name next to where it's going,
    so something half restored is never mistaken for the real thing, then moved into place once complete,
    along with the files from any nested locations that its snapshot leaves out, each where it is inside it."""
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
        restore_into(job, source, working)
        for part, (inside, rel) in enumerate(nested, 1):
            job.update(part=part, files=0, totalFiles=None, bytes=0, totalBytes=None)
            # Restored on its own first, then only what the outer snapshot hasn't got is moved in, as both can have
            # files in there: anything the outer one has comes from it
            alone = working.with_name(f'{working.name}-nested-{job["id"]}-{part}')
            job['alone'] = str(alone)
            restore_into(job, inside['rootEntry']['obj'], alone)
            into = working / rel
            # Moving things in changes the modified times of the folders it's in, so they're put back after
            above = [p for p in into.parents[:len(rel.parts)] if p.is_dir()]
            times = [(p, (p.stat().st_atime, p.stat().st_mtime)) for p in above]
            move_missing(alone, into)
            job.pop('alone')
            for folder, folder_times in times:
                os.utime(folder, folder_times)
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
        # A partial restore is no use, so it isn't left behind, nor a nested location's restored on its own
        for partial in [working, job.get('alone') and Path(job['alone'])]:
            if partial and partial.exists():
                shutil.rmtree(partial) if partial.is_dir() else partial.unlink()
    finally:
        job['finished'] = time.time()


def folder_object(root, parts):
    """kopia's ID for a folder inside another, by the names of the folders on the way to it, or None if it
    isn't there"""
    obj = root
    for part in parts:
        obj = next((e['o'] for e in listing(obj) if e['n'] == part and e['t'] == 'd'), None)
        if obj is None:
            return None
    return obj


def nested_additions(snapshot_id, path, nested_ids):
    """What snapshots of locations nested inside a folder being restored have to add to it, by ID: 'all' when the
    folder's snapshot has none of the location's files, as when it's left out altogether, 'some' when it has some
    but the nested snapshot has others too, and 'none' when the nested snapshot has nothing it hasn't got. Any
    that can't be checked have 'some', so they're still offered."""
    snap = repository.snapshots[snapshot_id]
    here = path.split('/') if path else []
    folder = Path(snap['source']['path'], *here)

    def adds(nested_id):
        try:
            inside = repository.snapshots[nested_id]
            if not inside['rootEntry'].get('summ', {}).get('files', 1):
                return 'none'
            parts = [*here, *Path(inside['source']['path']).relative_to(folder).parts]
            above = folder_object(snap['rootEntry']['obj'], parts[:-1])
            there = above and next((e for e in listing(above) if e['n'] == parts[-1] and e['t'] == 'd'), None)
            if not there or not there['f']:
                return 'all'
            if there['o'] == inside['rootEntry']['obj']:
                return 'none'
            output = kopia('diff', there['o'], inside['rootEntry']['obj']).splitlines()
            return 'some' if any((m := DIFF_FILE.match(line)) and m[1] == ADDED for line in output) else 'none'
        except (KeyError, ValueError, RuntimeError) as e:
            print(f'Couldn\'t check {nested_id} for anything to add: {kopia_reason(e)}', flush=True)
            return 'some'
    return dict(zip(nested_ids, pool.map(adds, nested_ids)))


def move_missing(finished, target):
    """Move what a nested location's restore has that the outer one's hasn't got into it, where it goes, folders
    and all. Anything already there stays as it is, folders' modified times too; folders it makes keep their times
    as restored."""
    times = {}

    def make(rel):
        # The folders on the way to it, remembering their times as they were, or as restored for ones made
        for depth in range(len(rel.parts) + 1):
            folder = target / Path(*rel.parts[:depth])
            if folder not in times:
                stat = (folder if folder.exists() else finished / Path(*rel.parts[:depth])).stat()
                times[folder] = (stat.st_atime, stat.st_mtime)
                folder.mkdir(parents=True, exist_ok=True)

    for folder, _, files in os.walk(finished):
        rel = Path(folder).relative_to(finished)
        make(rel)
        for name in files:
            if not (target / rel / name).exists():
                os.replace(Path(folder) / name, target / rel / name)
    # Deepest first, as setting a folder's times doesn't change its parent's
    for folder, folder_times in sorted(times.items(), key=lambda t: -len(t[0].parts)):
        os.utime(folder, folder_times)
    shutil.rmtree(finished)


def restore_into(job, source, into):
    """Have kopia restore something to a path, following its progress in the restore's record"""
    # Progress lines end in carriage returns, which text mode reads as line ends
    started = time.time()
    last = ''
    with subprocess.Popen(['kopia', 'restore', '--progress', source, str(into)], stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace') as process:
        for line in process.stdout:
            if match := PROGRESS.search(line):
                files, size, unit, total_files, total, total_unit = match.groups()
                job.update(files=min(int(files), int(total_files)), totalFiles=int(total_files),
                           bytes=min(size_of(size, unit), size_of(total, total_unit)), totalBytes=size_of(total, total_unit))
            elif line.strip():
                last = line.strip()
    log_command(process.args[1:], started, process.returncode and (last or f'exit code {process.returncode}'))
    if process.returncode:
        raise RuntimeError(last or f'kopia restore failed with exit code {process.returncode}')


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
        log_command(process.args[1:], job['started'], process.wait() and (last or f'exit code {process.returncode}'))
        if process.returncode or not result:
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


MOUNTED = re.compile(r"^Mounted '.*' on (\S+)")
# How kopia's mounts show in net use and netstat: a drive mapped to a WebDAV server on this computer, on a port
# the kopia process is listening on
WEBDAV_DRIVE = re.compile(r'([A-Z]:)\s+\\\\(?:127\.0\.0\.1|localhost)@(\d+)\\DavWWWRoot', re.I)
LISTENING = re.compile(r'^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$', re.M)
MOUNT_CHECK = 60                 # Seconds between checks on what's mounted
KOPIA_PROCESSES = 'Get-CimInstance Win32_Process -Filter "Name=\'kopia.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json'


def free_drives():
    """The drive letters nothing's using, to mount on: kopia only mounts as a drive on Windows, not in a folder."""
    used = ctypes.windll.kernel32.GetLogicalDrives()
    return [f'{letter}:' for i, letter in enumerate(string.ascii_uppercase) if not used & 1 << i]


def mount_object(snap, path):
    """What kopia mounts for a folder in a snapshot: the snapshot's root folder, or a folder inside it."""
    return f'{snap["rootEntry"]["obj"]}/{path}' if path else snap['rootEntry']['obj']


def start_mount(snapshot_id, path, drive):
    """Mount a folder as it was in a snapshot as a drive, read only, in the background, as KopiaUI does, and open
    it in Explorer once it's ready. It stays mounted until unmounted, or the explorer's closed. One already
    mounted is opened again instead, wherever it's mounted, even from another snapshot with the same contents."""
    snap = repository.snapshots[snapshot_id]
    if being_deleted(snapshot_id):
        raise BusyError('That snapshot is being deleted')
    obj = mount_object(snap, path)
    already = next((j for j in jobs.values() if j['kind'] == 'mount' and j['obj'] == obj and j['state'] in ('mounting', 'mounted')), None)
    if already:
        if already['drive']:
            subprocess.Popen(['explorer', already['drive']])
        return already
    if not re.fullmatch(r'[A-Z]:', drive or ''):
        raise ValueError(f'{drive} isn\'t a drive letter')
    # In a process group of its own, so it can be sent Ctrl+Break to unmount it, which kopia needs to take the
    # drive away again, without stopping this server
    process = subprocess.Popen(['kopia', 'mount', '--no-browse', obj, drive], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    job = mount_job(obj, snap, path, 'mounting', None, process.pid)
    mount_processes[job['id']] = process
    threading.Thread(target=run_mount, args=(job, process), daemon=True).start()
    return job


def mount_job(obj, snap, path, state, drive, pid, found=False):
    """A mount's record, for the page to follow: what's mounted, from which snapshot if it's known, where, and
    by which kopia process. Found is one found running rather than started here."""
    source = Path(snap['source']['path']) if snap else None
    job = {
        'id': next(job_ids), 'kind': 'mount', 'obj': obj, 'snapshot': snap and snap['id'], 'path': path,
        'name': (path.rsplit('/', 1)[-1] if path else str(source)) if snap else obj,
        'from': (str(source / path) if path else str(source)) if snap else obj,
        'snapshotTime': snap and snap['startTime'], 'state': state, 'drive': drive, 'pid': pid, 'found': found,
        'error': None, 'started': time.time(), 'finished': None,
    }
    jobs[job['id']] = job
    return job


def run_mount(job, process):
    """Wait for a mount to be ready, open it, then follow it until it's unmounted, or stops by itself."""
    last = ''
    try:
        for line in process.stdout:
            line = line.strip()
            if match := MOUNTED.match(line):
                job.update(state='mounted', drive=f'{match[1]}\\')
                subprocess.Popen(['explorer', job['drive']])
            elif line and not line.startswith(('HINT:', 'Press Ctrl-C')):
                last = line
        log_command(process.args[1:], job['started'], process.wait() and job['state'] != 'unmounting'
                    and (last or f'exit code {process.returncode}'))
        if job['state'] == 'unmounting':
            job['state'] = 'unmounted'
        else:
            job.update(state='failed', error=last or f'kopia mount stopped with exit code {process.returncode}')
    except Exception as e:
        job.update(state='failed', error=kopia_reason(e))
    finally:
        mount_processes.pop(job['id'], None)
        job['finished'] = time.time()


def unmount(job_id):
    """Unmount a folder mounted as a drive, as Ctrl+C would, so kopia takes the drive away. If it hasn't stopped
    after half a minute, it's ended outright, and the drive taken away here. One found running rather than started
    here can't be sent Ctrl+Break, so it's ended outright straight away."""
    job = jobs[job_id]
    if job['state'] not in ('mounting', 'mounted'):
        return job
    job['state'] = 'unmounting'
    process = mount_processes.get(job_id)
    if process:
        process.send_signal(signal.CTRL_BREAK_EVENT)

        def force():
            if process.poll() is None:
                process.kill()
                remove_drive(job['drive'])
        timer = threading.Timer(30, force)
        timer.daemon = True
        timer.start()
    else:
        def end():
            subprocess.run(['taskkill', '/PID', str(job['pid']), '/F'], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            remove_drive(job['drive'])
            job.update(state='unmounted', finished=time.time())
        threading.Thread(target=end, daemon=True).start()
    return job


def remove_drive(drive):
    if drive:
        subprocess.run(['net', 'use', drive.rstrip('\\'), '/delete', '/y'], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)


def command_line_args(command_line):
    """A program's command line split into its arguments, as Windows does for it."""
    shell32, kernel32 = ctypes.windll.shell32, ctypes.windll.kernel32
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    count = ctypes.c_int()
    args = shell32.CommandLineToArgvW(command_line, ctypes.byref(count))
    if not args:
        return []
    try:
        return [args[i] for i in range(count.value)]
    finally:
        kernel32.LocalFree(args)


def kopia_drives():
    """Every drive a kopia process is serving, however it was mounted: the process's ID and arguments, and the drive.
    A kopia mount serves one; a server, such as KopiaUI's, one for each folder mounted through it."""
    def run(*command):
        return subprocess.run(command, capture_output=True, text=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW).stdout
    found = run('powershell', '-NoProfile', '-Command', KOPIA_PROCESSES)
    processes = json.loads(found) if found.strip() else []
    args = {p['ProcessId']: command_line_args(p['CommandLine'] or '')[1:] for p in (processes if isinstance(processes, list) else [processes])}
    if not args:
        return []
    drives = {int(port): f'{drive.upper()}\\' for drive, port in WEBDAV_DRIVE.findall(run('net', 'use'))}
    return [(int(pid), args[int(pid)], drives[int(port)]) for port, pid in LISTENING.findall(run('netstat', '-ano', '-p', 'TCP'))
            if int(pid) in args and int(port) in drives]


def running_mounts():
    """Every kopia mount running, however it was started, that's mounted on a drive: by process ID, what it mounts
    and on which drive. Not ones KopiaUI has mounted, as its server does those itself, without saying what they are."""
    mounted = {}
    for pid, args, drive in kopia_drives():
        if 'mount' in args:
            positional = [a for a in args[args.index('mount') + 1:] if not a.startswith('-')]
            mounted[pid] = (positional[0] if positional else 'all', drive)
    return mounted


def other_mounts():
    """Drives mounted through a kopia server, such as KopiaUI's, rather than by kopia mount: all that's known is the
    drive, and what mounted it, as the server's mounts can only be asked about with its password."""
    return sorted(({'drive': drive, 'by': 'KopiaUI' if '--ui' in args else 'a Kopia server'}
                   for pid, args, drive in kopia_drives() if 'mount' not in args), key=lambda m: m['drive'])


def check_mounts():
    """Bring the mounts listed up to date with what's really mounted: ones found running that aren't listed, such as
    ones left by an explorer that was ended outright, or mounted at the command line, are listed, and ones whose
    drive has been taken away, or whose kopia has stopped, are unmounted. The newest snapshot with what's mounted
    is taken to be the one it's from."""
    mounted = running_mounts()
    listed = {j['pid'] for j in jobs.values() if j['kind'] == 'mount' and j['state'] in ('mounting', 'mounted', 'unmounting')}
    for job in [j for j in jobs.values() if j['kind'] == 'mount' and j['state'] == 'mounted']:
        if job['pid'] not in mounted:
            unmount(job['id'])
    for pid, (obj, drive) in mounted.items():
        if pid in listed:
            continue
        root, _, path = obj.partition('/')
        snaps = [s for s in repository.snapshots.values() if s['rootEntry']['obj'] == root]
        mount_job(obj, max(snaps, key=lambda s: s['startTime'], default=None), path, 'mounted', drive, pid, found=True)


def keep_checking_mounts():
    while True:
        try:
            check_mounts()
        except Exception:
            traceback.print_exc()
        time.sleep(MOUNT_CHECK)


def policy_key(path):
    return f'{repository.info["user"]}@{repository.info["host"]}:{path}'


def policy_chain(path):
    """The policies a folder's settings come from, in the order kopia looks: its own, the folders above it, then
    the user's, the computer's and the global policy, each as its key and its name in words"""
    user, host = repository.info['user'], repository.info['host']
    folder = Path(path)
    chain = [(policy_key(p), str(p)) for p in [folder, *folder.parents]]
    return chain + [(f'{user}@{host}', f'{user}@{host}'), (f'@{host}', host), ('(global)', 'the global policy')]


def schedule_of(path, policies=None, nested=True):
    """How often a folder is backed up on its own, as kopia works it out: from its own policy, or the nearest
    folder above with one, or the user's, the computer's or the global policy, each setting from the first
    that has it. Says where its schedule came from, whether the folder has its own (an interval, or manual
    snapshots only), and what the interval would be without it, and how many of its snapshots are kept. The
    policies are read unless given. Whether it's missing settings from a location it's inside is left out
    unless nested, as that asks kopia again."""
    if policies is None:
        policies = repository.policies()
    folder = Path(path)
    chain = policy_chain(path)

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
    # Manual snapshots only decides it, wherever that's set
    if found.get('manual', (False, None))[0]:
        source = found['manual'][1]
    own = (policies.get(policy_key(folder)) or {}).get('scheduling') or {}
    return {
        'path': path, 'interval': interval, 'from': None if source == str(folder) else source,
        'times': [f'{t["hour"]:02}:{t["min"]:02}' for t in found.get('timeOfDay', ([], None))[0]],
        'cron': found.get('cron', ([], None))[0], 'manual': found.get('manual', (False, None))[0],
        'own': 'intervalSeconds' in own or bool(own.get('manual')), 'ownManual': bool(own.get('manual')),
        'inherited': dict(zip(('interval', 'from'), above.get('intervalSeconds', (None, None)))),
        'keep': retention_of(chain, policies),
        **({'nested': nested_status(path, policies)} if nested else {}),
    }


# How many snapshots of each kind kopia's retention policy keeps, by kopia's names for them in policies
RETENTION = {'latest': 'keepLatest', 'hourly': 'keepHourly', 'daily': 'keepDaily', 'weekly': 'keepWeekly',
             'monthly': 'keepMonthly', 'annual': 'keepAnnual'}


def retention_of(chain, policies):
    """How many of a folder's snapshots of each kind are kept, from the policies it gets its settings from: what
    its own policy says, if anything, and what it would inherit without it, and from where. One set nowhere is
    None, which kopia takes as none."""
    retention = [((policies.get(key) or {}).get('retention') or {}, name) for key, name in chain]
    keep = {}
    for kind, setting in RETENTION.items():
        inherited, source = next(((r[setting], name) for r, name in retention[1:] if setting in r), (None, None))
        keep[kind] = {'own': retention[0][0].get(setting), 'inherited': inherited, 'from': source}
    return keep


def check_retention(keep):
    """How many snapshots of each kind to keep, by kind: each a whole number, or None to inherit it"""
    for kind, count in keep.items():
        if kind not in RETENTION or (count is not None and (not isinstance(count, int) or isinstance(count, bool) or count < 0)):
            raise KeyError(kind)


def set_retention(policy, keep):
    """Set how many snapshots of each kind a policy keeps, as KopiaUI's policy editor does: a whole number, or None
    to inherit it, taken out of the policy. Kopia applies it after the location's next snapshot."""
    check_retention(keep)
    retention = policy.setdefault('retention', {})
    for kind, count in keep.items():
        if count is None:
            retention.pop(RETENTION[kind], None)
        else:
            retention[RETENTION[kind]] = count


def all_schedules():
    """Every backup location's schedule by its path, for the sidebar's next snapshots, and the global policy's,
    as (global). The policies are read once and nothing else asks kopia, so it's quick, and doesn't wait behind
    the pool's work."""
    policies = repository.policies()
    return {**{path: schedule_of(path, policies, nested=False) for path in sorted(repository.sources)},
            GLOBAL: global_schedule(policies)}


def set_schedule(path, interval, manual=False, copy_settings=False, keep=None):
    """Back a folder up every so often on its own, or with manual snapshots only, or with neither, as the policy
    above it says, keeping as many of its snapshots of each kind as given, if they are. Only its own policy's
    schedule and retention change: it's exported, changed and imported back, as kopia's policy set can't put an
    interval back to inherited. Any folder on the PC can have one, which makes it a
    backup location: kopia's scheduler backs up folders with a policy of their own, unless manual snapshots
    only. A new one inside another location can have the settings it would inherit copied in too."""
    # Tidied, so the same folder typed differently is the same location
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        raise ValueError(f'There\'s no folder {path}')
    if interval is not None:
        check_interval(interval)
    key = policy_key(path)
    existing = repository.policies(fresh=True).get(key)
    policy = existing or {}
    scheduling = policy.setdefault('scheduling', {})
    if manual:
        # kopia's scheduler leaves it alone, so it's only backed up when asked
        scheduling.pop('intervalSeconds', None)
        scheduling['manual'] = True
    elif interval is None:
        scheduling.pop('intervalSeconds', None)
        scheduling.pop('manual', None)
    else:
        # Backed up on a schedule, so not manual snapshots only
        scheduling.update(intervalSeconds=interval)
        scheduling.pop('manual', None)
    if keep is not None:
        set_retention(policy, keep)
    import_policy(key, policy)
    # Without the settings it would inherit, the location it's in stops using them in here when backed up
    if copy_settings and existing is None and containing_location(path):
        copy_settings_in(path)
    return schedule_of(path)


def check_interval(interval):
    # Whole minutes, and no more often than KopiaUI offers
    if not isinstance(interval, int) or isinstance(interval, bool) or interval < 600 or interval % 60:
        raise KeyError(interval)


# The global policy, which every location gets its settings from unless something nearer sets them, as KopiaUI's
# policy list shows it, for every user and computer, and as kopia names it in policy export and import
GLOBAL = '(global)'


def global_schedule(policies=None):
    """How often the global policy says to back up, and how many snapshots of each kind it keeps, as schedule_of
    gives a folder's, with nothing above it to inherit from. The policies are read unless given."""
    if policies is None:
        policies = repository.policies()
    policy = policies.get(GLOBAL) or {}
    scheduling, retention = policy.get('scheduling') or {}, policy.get('retention') or {}
    return {
        'path': None, 'interval': scheduling.get('intervalSeconds'), 'from': None,
        'times': [f'{t["hour"]:02}:{t["min"]:02}' for t in scheduling.get('timeOfDay') or []],
        'cron': scheduling.get('cron') or [], 'manual': bool(scheduling.get('manual')),
        'own': True, 'ownManual': bool(scheduling.get('manual')), 'inherited': {'interval': None, 'from': None},
        'keep': {kind: {'own': retention.get(setting), 'inherited': None, 'from': None} for kind, setting in RETENTION.items()},
    }


def set_global_schedule(interval, keep):
    """Set how often the global policy says to back up, which isn't manual snapshots only then, and how many
    snapshots of each kind it keeps, all of which it must say, as there's nothing above it to inherit them from.
    Every location that doesn't set them nearer to it goes by these. Set with kopia policy set, which replaces the
    global policy, as kopia policy import adds another alongside it instead, which kopia may read either of."""
    check_interval(interval)
    check_retention(keep)
    if set(keep) != set(RETENTION) or any(count is None for count in keep.values()):
        raise ValueError('The global policy needs a number for each kind of snapshot to keep')
    manual = global_schedule(repository.policies(fresh=True))['manual']
    change_policies('set', '--global', f'--snapshot-interval={interval}s', *[f'--keep-{kind}={count}' for kind, count in keep.items()],
          *(['--no-manual'] if manual else []))
    return global_schedule()


def change_policies(*args, **kwargs):
    """A kopia policy command that changes policies, which are read again when next wanted, even if it fails, as
    it may have changed some"""
    try:
        return kopia('policy', *args, **kwargs)
    finally:
        repository.policies_changed()


def import_policy(key, policy):
    change_policies('import', key, input=json.dumps({key: policy}))


# Settings kopia reads folder by folder while backing up. Inside a folder with a policy of its own, while a
# location it's in is backed up, kopia takes these from that policy alone, rather than what it would inherit,
# and uses its own defaults for any it leaves unset (kopia issue #3671), so they're copied into it. Each is
# (code for the marker, section, setting, what kopia uses when it's unset there, or None to always copy it).
# Kopia PR #5766 (https://github.com/kopia/kopia/pull/5766, for issue #5763) makes kopia inherit them there, so
# once a release includes it, copying them in is only needed for older versions.
PASSED_ON = [
    ('dot-ignore', 'files', 'ignoreDotFiles', []),
    ('cache-dirs', 'files', 'ignoreCacheDirs', True),
    ('one-fs', 'files', 'oneFileSystem', False),
    ('compress', 'compression', 'compressorName', 'none'),
    ('compress-min', 'compression', 'minSize', None),
    ('compress-max', 'compression', 'maxSize', None),
    ('compress-only', 'compression', 'onlyCompress', None),
    ('compress-never', 'compression', 'neverCompress', None),
    ('meta-compress', 'metadataCompression', 'compressorName', None),
    ('splitter', 'splitter', 'algorithm', None),
    ('file-errors', 'errorHandling', 'ignoreFileErrors', False),
    ('dir-errors', 'errorHandling', 'ignoreDirectoryErrors', False),
    ('unknown-types', 'errorHandling', 'ignoreUnknownTypes', True),
]
SETTING_NAMES = {
    'dot-ignore': 'ignore files', 'cache-dirs': 'cache folders', 'one-fs': 'one file system',
    'compress': 'compression', 'compress-min': 'compression', 'compress-max': 'compression',
    'compress-only': 'compression', 'compress-never': 'compression', 'meta-compress': 'metadata compression',
    'splitter': 'splitter', 'file-errors': 'error handling', 'dir-errors': 'error handling',
    'unknown-types': 'error handling',
}
# Which settings were copied in, so they can be kept up to date and taken out again, and a hash of their values,
# to tell when they've been changed by hand since. It's kept as an ignore file name, the only place in a policy
# for it that changes nothing: kopia looks for a file by that name in each folder, and there's never one.
MARKER = re.compile(r'\.kopia-explorer\(([\w,-]*);([0-9a-f]{8})\)')


def marker_in(policy):
    """The settings copied into a policy, and the hash of their values then, or (None, None) if none were"""
    for name in policy.get('files', {}).get('ignoreDotFiles', []):
        if match := MARKER.fullmatch(name):
            return [code for code in match[1].split(',') if code], match[2]
    return None, None


def setting(policy, code):
    _, section, name, _ = next(s for s in PASSED_ON if s[0] == code)
    value = policy.get(section, {}).get(name)
    # Without the marker, and in kopia's order, so it compares the same however it was saved
    if code == 'dot-ignore' and value is not None:
        value = sorted(n for n in value if not MARKER.fullmatch(n)) or None
    return value


def values_hash(policy, codes):
    values = json.dumps({code: setting(policy, code) for code in codes}, sort_keys=True)
    return hashlib.sha1(values.encode('utf-8')).hexdigest()[:8]


def needed(above, code):
    """Whether a setting has to be copied in: when it's set above, to something other than what kopia uses
    in its place"""
    value, fallback = setting(above, code), next(s[3] for s in PASSED_ON if s[0] == code)
    return value is not None and (fallback is None or value != fallback)


def containing_location(path):
    """The nearest backup location that a folder is inside, not counting itself"""
    inside = [s for s in repository.sources
              if (path.lower() + '\\').startswith(s.rstrip('\\').lower() + '\\') and s.lower() != path.lower()]
    return max(inside, key=len, default=None)


def settings_above(path):
    """What a folder would inherit: everything set for the folder it's in, from all the policies above"""
    return json.loads(kopia('policy', 'show', '--json', str(Path(path).parent)))


def nested_status(path, policies):
    """For a location inside another, which settings that location's backups don't use in here and which have
    been copied in: whether they've been changed by hand since, and whether they're behind the ones above"""
    policy = policies.get(policy_key(path))
    container = containing_location(path)
    if policy is None or not container:
        return None
    above = settings_above(path)
    codes, stamp = marker_in(policy)
    copied = codes or []
    missing = [s[0] for s in PASSED_ON if s[0] not in copied and setting(policy, s[0]) is None and needed(above, s[0])]
    names = lambda found: list(dict.fromkeys(SETTING_NAMES[code] for code in found))
    return {
        'container': container, 'missing': names(missing), 'copied': names(copied),
        'edited': codes is not None and values_hash(policy, copied) != stamp,
        'behind': any(setting(policy, code) != setting(above, code) for code in copied),
    }


def copy_settings_in(path):
    """Copy the settings a location inside another would inherit into its own policy, or bring them up to date,
    so the other location's backups use them in here. Only settings it leaves unset are copied, and any copied
    before that have been changed by hand since are left as they are, as its own."""
    key = policy_key(path)
    policy = repository.policies(fresh=True).get(key)
    if policy is None or not containing_location(path):
        raise ValueError(f'{path} isn\'t a backup location inside another')
    above = settings_above(path)
    codes, stamp = marker_in(policy)
    copied = codes or []
    if codes is not None and values_hash(policy, copied) != stamp:
        copied = [code for code in copied if setting(policy, code) == setting(above, code)]
    marker = next((n for n in policy.get('files', {}).get('ignoreDotFiles', []) if MARKER.fullmatch(n)), None)
    result = []
    for code, section, name, _ in PASSED_ON:
        if code in copied or setting(policy, code) is None:
            if needed(above, code):
                # Without the marker of any location above that's had settings copied in
                value = setting(above, code)
                # Ignore files of its own are kept alongside
                if code == 'dot-ignore':
                    own = [n for n in setting(policy, code) or [] if n not in value] if code in copied else []
                    value = sorted({*value, *own})
                policy.setdefault(section, {})[name] = value
                result.append(code)
            elif code in copied:
                policy.get(section, {}).pop(name, None)
    write_marker(policy, marker, result)
    import_policy(key, policy)


def undo_copied_settings(path):
    """Take the copied settings out of a location's policy again, apart from any changed by hand since"""
    key = policy_key(path)
    policy = repository.policies(fresh=True).get(key) or {}
    codes, stamp = marker_in(policy)
    if codes is None:
        return
    above = settings_above(path)
    edited = values_hash(policy, codes) != stamp
    marker = next(n for n in policy['files']['ignoreDotFiles'] if MARKER.fullmatch(n))
    for code, section, name, _ in PASSED_ON:
        if code in codes and (not edited or setting(policy, code) == setting(above, code)):
            if code == 'dot-ignore':
                # Ignore files of its own stay
                policy['files'][name] = [n for n in policy['files'][name] if n not in (setting(above, code) or [])]
            else:
                policy.get(section, {}).pop(name, None)
    write_marker(policy, marker, [])
    import_policy(key, policy)


def write_marker(policy, old, codes):
    files = policy.setdefault('files', {})
    names = [n for n in files.get('ignoreDotFiles', []) if n != old]
    if codes:
        names.append(f'.kopia-explorer({",".join(codes)};{values_hash(policy, codes)})')
    if names:
        files['ignoreDotFiles'] = names
    else:
        files.pop('ignoreDotFiles', None)


def nested_settings():
    """Every location inside another whose backups don't use some of the settings it would inherit in there, or
    that's had them copied in, with which"""
    policies = repository.policies()
    prefix = policy_key('')
    paths = sorted(key[len(prefix):] for key in policies if key.startswith(prefix))
    found = zip(paths, pool.map(lambda path: nested_status(path, policies), paths))
    return [{'path': path, **status} for path, status in found if status and (status['missing'] or status['copied'])]


def needing_settings():
    """Every location inside another whose backups don't use some of the settings it would inherit in there,
    and that's had none copied in yet"""
    return [n for n in nested_settings() if n['missing'] and not n['copied']]


def with_copied_settings():
    """Every location that's had settings copied in"""
    policies = repository.policies()
    prefix = policy_key('')
    return sorted(key[len(prefix):] for key, policy in policies.items()
                  if key.startswith(prefix) and marker_in(policy)[0] is not None)


# Settings changes wait for any before them, as each reads and rewrites policies
settings_lock = threading.Lock()


def start_settings(undo, paths=None):
    """Copy settings into locations inside others, or take them out again, in the background, one location at a
    time, returning its progress record, with an item for each location. Without paths, it's every location that
    needs them, or every one that has them."""
    job = {
        'id': next(job_ids), 'kind': 'settings', 'name': 'settings', 'undo': undo,
        'state': 'checking' if paths is None else 'waiting', 'error': None, 'started': time.time(), 'finished': None,
        'items': [{'path': path, 'state': 'waiting', 'error': None} for path in paths or []],
    }
    jobs[job['id']] = job
    threading.Thread(target=run_settings, args=(job,), daemon=True).start()
    return job


def run_settings(job):
    try:
        with settings_lock:
            if job['state'] == 'checking':
                # Finding them takes a few seconds, as each one's settings above are read
                paths = with_copied_settings() if job['undo'] else [n['path'] for n in needing_settings()]
                job['items'] = [{'path': path, 'state': 'waiting', 'error': None} for path in paths]
            job['state'] = 'running'
            for item in job['items']:
                item['state'] = 'running'
                try:
                    (undo_copied_settings if job['undo'] else copy_settings_in)(item['path'])
                    item['state'] = 'done'
                except Exception as e:
                    item.update(state='failed', error=kopia_reason(e))
        job['state'] = 'done'
    except Exception as e:
        job.update(state='failed', error=kopia_reason(e))
    finally:
        job['finished'] = time.time()


def keep_copied_settings_up_to_date():
    """At startup: bring settings copied into locations inside others up to date with the ones above, unless
    they've been changed by hand since. The page offers to copy them into locations that need them."""
    try:
        policies = repository.policies()
        prefix = policy_key('')
        for path in sorted(key[len(prefix):] for key in policies if key.startswith(prefix)):
            status = nested_status(path, policies)
            if status and status['copied'] and not status['edited'] and (status['behind'] or status['missing']):
                copy_settings_in(path)
                print(f'Brought the settings copied into {path} up to date', flush=True)
    except RuntimeError as e:
        print(f'Couldn\'t check the settings of locations inside others: {kopia_reason(e)}', flush=True)


def being_deleted(snapshot_id):
    return any(j['kind'] == 'delete' and j['snapshot'] == snapshot_id and not j['finished'] for j in jobs.values())


def start_delete(snapshot_id):
    """Delete a snapshot from the repository for good, in the background, returning its progress record. Not one
    still being made, which kopia replaces as it goes; a cancelled one, or one left behind, is fine, along with the
    earlier checkpoints of the same backup shown as it. Only the snapshot's record goes, so
    a restore already running from it carries on: its data stays until kopia's maintenance finds nothing uses it."""
    snap = repository.snapshots[snapshot_id]
    if snapshot_id in repository.live:
        raise BusyError('That snapshot is still being made')
    if being_deleted(snapshot_id):
        raise BusyError('That snapshot is already being deleted')
    if being_pinned(snapshot_id):
        raise BusyError('That snapshot is being pinned or unpinned')
    job = {
        'id': next(job_ids), 'kind': 'delete', 'name': snap['source']['path'], 'source': snap['source']['path'],
        'snapshot': snapshot_id, 'also': repository.folded.get(snapshot_id, []), 'snapshotTime': snap['startTime'], 'state': 'deleting', 'error': None,
        'started': time.time(), 'finished': None,
    }
    jobs[job['id']] = job
    threading.Thread(target=run_delete, args=(job,), daemon=True).start()
    return job


def run_delete(job):
    try:
        ids = [job['snapshot'], *job['also']]
        kopia('snapshot', 'delete', *ids, '--delete')
        for snapshot_id in ids:
            repository.snapshots.pop(snapshot_id, None)
        job['state'] = 'done'
    except Exception as e:
        job.update(state='failed', error=kopia_reason(e))
    finally:
        job['finished'] = time.time()


def being_pinned(snapshot_id):
    return any(j['kind'] == 'pin' and j['snapshot'] == snapshot_id and not j['finished'] for j in jobs.values())


def start_pin(snapshot_id, add, remove):
    """Pin a finished snapshot under names, or take pins off it, in the background, returning its progress record.
    Meanwhile it can't be deleted, as kopia gives it a new ID, and the delete would be by its old one. Once done,
    the record has the snapshot as it is now, for the page to follow it to its new ID."""
    snap = repository.snapshots[snapshot_id]
    if snap.get('incomplete'):
        raise BusyError('Only finished snapshots can be pinned')
    if being_deleted(snapshot_id):
        raise BusyError('That snapshot is being deleted')
    if being_pinned(snapshot_id):
        raise BusyError('That snapshot is already being pinned or unpinned')
    add, remove = [p.strip() for p in add if p.strip()], [p.strip() for p in remove if p.strip()]
    if not add and not remove:
        raise ValueError('No pins to add or remove')
    job = {
        'id': next(job_ids), 'kind': 'pin', 'name': snap['source']['path'], 'source': snap['source']['path'],
        'snapshot': snapshot_id, 'snapshotTime': snap['startTime'], 'add': add, 'remove': remove, 'info': None,
        'state': 'running', 'error': None, 'started': time.time(), 'finished': None,
    }
    jobs[job['id']] = job
    threading.Thread(target=run_pin, args=(job,), daemon=True).start()
    return job


def run_pin(job):
    try:
        job['info'] = repository.change_pins(job['snapshot'], job['add'], job['remove'])
        job['state'] = 'done'
    except Exception as e:
        job.update(state='failed', error=kopia_reason(e))
    finally:
        job['finished'] = time.time()


REPOSITORY_SIZE = re.compile(r'^Total Packed: ([\d.]+) (\w+)', re.M)


def repository_size():
    """The repository's exact size on disk, from kopia's index, which it keeps a copy of locally: all the data
    stored, once however many locations share it. It takes a few seconds, so it's only worked out when asked."""
    match = REPOSITORY_SIZE.search(kopia('content', 'stats'))
    if not match:
        raise RuntimeError('kopia content stats didn\'t say how much is stored')
    return {'size': size_of(*match.groups())}


KOPIA_UI = 'KopiaUI.exe'
# Where its installer puts it: for everyone, or just the one user
KOPIA_UI_PATHS = [Path(os.environ.get(var, '')) / folder / KOPIA_UI for var, folder in
                  [('ProgramFiles', 'KopiaUI'), ('LOCALAPPDATA', 'Programs/KopiaUI')] if os.environ.get(var)]


def kopia_ui():
    """Whether KopiaUI is running, as only its server makes the scheduled snapshots, and whether it can be
    started from here. Running is None if it couldn't be told. Since is when its server started, as a Unix time,
    as it backs up whatever fell due while it wasn't running then, or None if it isn't running or that can't
    be found out."""
    try:
        running = processes()
    except OSError:
        return {'running': None, 'since': None, 'startable': any(p.is_file() for p in KOPIA_UI_PATHS)}
    server = kopia_ui_server(running)
    return {'running': any(name.lower() == KOPIA_UI.lower() for _, _, name in running), 'since': server and started(server),
            'startable': any(p.is_file() for p in KOPIA_UI_PATHS)}


def kopia_ui_server(running):
    """KopiaUI's server's process ID, among the processes running, as it's the kopia KopiaUI runs itself, or None"""
    kopia_ui_ids = {pid for pid, _, name in running if name.lower() == KOPIA_UI.lower()}
    return next((pid for pid, parent, name in running if parent in kopia_ui_ids and name.lower() == 'kopia.exe'), None)


def start_kopia_ui():
    """Start KopiaUI, on its own, so it keeps running after the explorer's closed."""
    path = next((p for p in KOPIA_UI_PATHS if p.is_file()), None)
    if not path:
        raise FileNotFoundError(f'Couldn\'t find {KOPIA_UI} in {" or ".join(str(p.parent) for p in KOPIA_UI_PATHS)}')
    subprocess.Popen([str(path)], cwd=path.parent, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    return {}


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG), ('dwFlags', wintypes.DWORD),
                ('szExeFile', wintypes.WCHAR * wintypes.MAX_PATH)]


def processes():
    """Every process running: its ID, its parent's, and its program's file name."""
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snapshot in (None, wintypes.HANDLE(-1).value):
        raise ctypes.WinError()
    entry = PROCESSENTRY32W(dwSize=ctypes.sizeof(PROCESSENTRY32W))
    found = []
    try:
        more = kernel32.Process32FirstW(wintypes.HANDLE(snapshot), ctypes.byref(entry))
        while more:
            found.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
            more = kernel32.Process32NextW(wintypes.HANDLE(snapshot), ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(wintypes.HANDLE(snapshot))
    return found


def started(pid):
    """When a process started, as a Unix time, or None if that can't be found out."""
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    times = [wintypes.FILETIME() for _ in range(4)]
    try:
        if not kernel32.GetProcessTimes(wintypes.HANDLE(handle), *map(ctypes.byref, times)):
            return None
    finally:
        kernel32.CloseHandle(wintypes.HANDLE(handle))
    # In 100ns steps since 1601
    return (times[0].dwHighDateTime << 32 | times[0].dwLowDateTime) / 10_000_000 - 11_644_473_600


def kopia_config():
    """Kopia's config for the repository, which the explorer and KopiaUI both use."""
    return Path(os.environ.get('KOPIA_CONFIG_PATH') or Path(os.environ.get('APPDATA', '')) / 'kopia' / 'repository.config')


# Kopia's snapshot actions, by their names in policies, in the order they run
ACTION_KINDS = {'beforeSnapshotRoot': 'Before snapshot', 'beforeFolder': 'Before folder',
                'afterFolder': 'After folder', 'afterSnapshotRoot': 'After snapshot'}


def with_actions(policies):
    """The policies that apply here with snapshot actions, from kopia policy export: what each is for, a folder's
    path or all the locations of the user, the computer or everyone, the folder if it's one, and each of its
    actions: when it runs, what it runs, as a script, how long it can take in seconds and what happens if it
    fails, as kopia has them, empty if not set. Other computers' policies don't run here."""
    user, host = repository.info['user'], repository.info['host']
    names = {'(global)': 'all locations', f'@{host}': 'all locations on this PC', f'{user}@{host}': f'all of {user}\'s locations'}
    prefix = policy_key('')
    found = []
    for key, policy in policies.items():
        actions = {kind: action for kind, action in (policy.get('actions') or {}).items() if action}
        if actions and (key in names or key.startswith(prefix)):
            path = None if key in names else key[len(prefix):]
            found.append({'name': names.get(key, path), 'path': path, 'actions': [{
                'kind': kind, 'when': when, 'timeout': actions[kind].get('timeout'), 'mode': actions[kind].get('mode', ''),
                # A command set at the command line, as a script that runs it, as KopiaUI shows it
                'script': actions[kind].get('script') or subprocess.list2cmdline([actions[kind].get('path', ''), *actions[kind].get('args', [])]),
            } for kind, when in ACTION_KINDS.items() if kind in actions]})
    return sorted(found, key=lambda p: p['name'].casefold())


ACTION_MODES = ('essential', 'optional', 'async')


def set_location_actions(path, before, after):
    """Set what a location's own policy runs before and after its snapshots, as KopiaUI's policy editor does: each
    as a script, with how long it can take in seconds and what happens if it fails, or none, taken out of the
    policy, where kopia's defaults apply. Any folder actions are kept. It's exported, changed and imported back."""
    if path not in repository.sources:
        raise PermissionError(f'{path} isn\'t a backup location')
    key = policy_key(path)
    existing = repository.policies(fresh=True).get(key)
    # Without a policy of its own, one's only made for actions to go in
    if existing is None and not any(a and a.get('script', '').strip() for a in (before, after)):
        return snapshot_actions()
    policy = existing or {}
    actions = policy.setdefault('actions', {})
    for kind, action in (('beforeSnapshotRoot', before), ('afterSnapshotRoot', after)):
        if not action or not action.get('script', '').strip():
            actions.pop(kind, None)
            continue
        timeout, mode = action.get('timeout'), action.get('mode') or None
        if timeout is not None and (not isinstance(timeout, int) or timeout < 1):
            raise KeyError(timeout)
        if mode is not None and mode not in ACTION_MODES:
            raise KeyError(mode)
        actions[kind] = {'script': action['script'], **({'timeout': timeout} if timeout else {}), **({'mode': mode} if mode else {})}
    import_policy(key, policy)
    repository.actions = None
    return snapshot_actions()


# The ignore file kopia reads in each folder it backs up, unless a policy says otherwise, and the one edited here,
# at the top of a location
IGNORE_FILE = '.kopiaignore'


def first_files_setting(chain, policies, setting):
    """A files setting as kopia works it out for a folder, from the first policy in its chain that has it, as a
    list there replaces the one above rather than adding to it, and the name of that policy; None for both if
    none has it"""
    for key, name in chain:
        files = (policies.get(key) or {}).get('files') or {}
        if setting in files:
            return files[setting], name
    return None, None


def ignore_location(path):
    """The backup location a folder's .kopiaignore is read in: the folder itself, if it's one, or the nearest
    it's inside. A folder above them all has none, as nothing backs it up."""
    location = path if path in repository.sources else containing_location(path)
    if not location:
        raise PermissionError(f'{path} isn\'t in a backup location')
    return location


def ignore_rules(file):
    """The rules in an ignore file, leaving out blank lines and comments; none if it isn't there"""
    try:
        text = file.read_text(encoding='utf-8-sig')
    except OSError:
        return []
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith('#')]


def ignore_file(path):
    """A folder's .kopiaignore, in a backup location or at its top, for editing: what's in it, with Unix line
    endings, whether it's there, and whether the folder's on disk to put one in; whether kopia reads it, as the
    folder's policy lists the ignore files it reads; the ignore rules in its policy, which apply as well, and the
    policy they're set in; and the rules in the .kopiaignore files of the folders above it in the location, which
    carry down into it."""
    location = ignore_location(path)
    folder = Path(path)
    try:
        content, exists = (folder / IGNORE_FILE).read_text(encoding='utf-8-sig').replace('\r\n', '\n'), True
    except FileNotFoundError:
        content, exists = '', False
    except OSError as e:
        raise ValueError(f'Couldn\'t read {IGNORE_FILE} in {path}: {e.strerror}')
    policies = repository.policies()
    chain = policy_chain(path)
    read, _ = first_files_setting(chain, policies, 'ignoreDotFiles')
    rules, rules_from = first_files_setting(chain, policies, 'ignore')
    above = [folder.parents[i] for i in reversed(range(len(folder.relative_to(location).parts)))]
    return {'path': path, 'location': location, 'name': IGNORE_FILE, 'exists': exists, 'onDisk': folder.is_dir(), 'content': content,
            'read': IGNORE_FILE in (read or []), 'policyRules': rules or [], 'policyFrom': rules_from,
            'above': [{'path': str(f / IGNORE_FILE), 'rules': r} for f in above if (r := ignore_rules(f / IGNORE_FILE))]}


def global_ignore(fresh=False):
    """The global policy's ignore rules, which apply from the top of every location that doesn't have a list of its
    own, or get one from a policy nearer to it, as a list there replaces this one; and those locations, as these
    don't apply to them. Also whether it ignores cache folders (with a CACHEDIR.TAG), which kopia does when it's
    unset, and the locations that do otherwise, by a setting nearer to them. The policies are read fresh if asked,
    as before changing them."""
    policies = repository.policies(fresh)
    files = (policies.get(GLOBAL) or {}).get('files') or {}
    rules = files.get('ignore') or []
    cache_dirs = files.get('ignoreCacheDirs', True)
    replaced = sorted((path for path in repository.sources
                       if first_files_setting(policy_chain(path), policies, 'ignore')[1] not in (None, 'the global policy')), key=str.casefold)
    cache_dirs_own = sorted((path for path in repository.sources
                             if first_files_setting(policy_chain(path), policies, 'ignoreCacheDirs')[0] not in (None, cache_dirs)), key=str.casefold)
    return {'rules': rules, 'replaced': replaced, 'cacheDirs': cache_dirs, 'cacheDirsOwn': cache_dirs_own}


def set_global_ignore(rules, cache_dirs=None):
    """Set the global policy's ignore rules, with kopia policy set, as kopia policy import adds another global policy
    alongside the one there instead: the ones no longer there are removed and the new ones added, in one go, as
    clearing and adding in one go leaves none. Kopia keeps them sorted, so there are no comments, which it would
    keep as rules and move. Whether it ignores cache folders is set along with them, if given and changed. The
    explorer's ignore rules are read again for every location, as they may have changed."""
    if not isinstance(rules, list) or any(not isinstance(r, str) or not r.strip() or '\n' in r or r.strip().startswith('#') for r in rules):
        raise ValueError('Each rule must be a pattern on a line of its own, with no comments')
    if cache_dirs is not None and not isinstance(cache_dirs, bool):
        raise ValueError('Whether to ignore cache folders must be true or false')
    wanted = {r.strip() for r in rules}
    current = global_ignore(fresh=True)
    there = set(current['rules'])
    changes = []
    if not wanted and there:
        changes.append('--clear-ignore')
    elif wanted != there:
        changes += [f'--remove-ignore={r}' for r in sorted(there - wanted)] + [f'--add-ignore={r}' for r in sorted(wanted - there)]
    if cache_dirs is not None and cache_dirs != current['cacheDirs']:
        changes.append(f'--ignore-cache-dirs={str(cache_dirs).lower()}')
    if changes:
        change_policies('set', '--global', *changes)
    repository.ignores.clear()
    return global_ignore()


def latest_complete(source):
    """A location's newest finished snapshot, or None"""
    snaps = [s for s in repository.snapshots.values() if s['source']['path'] == source and not s.get('incomplete')]
    return max(snaps, key=lambda s: s['startTime'], default=None)


def folder_in(root, parts):
    """A folder's object ID in a snapshot, from its root's, by the names of the folders down to it; None if it
    isn't there"""
    obj = root
    for part in parts:
        obj = next((e.get('o') for e in listing(obj) if e['t'] == 'd' and e['n'] == part), None)
        if not obj:
            return None
    return obj


# What a rule would leave out of a tree, by the tree's object ID and the rule, kept while the server runs, as a tree
# with the same ID never changes
rule_drops_cache = {}


def rule_drops(obj, line):
    """What an ignore rule, applying from the top of a snapshot's tree, would leave out of it: (folders, files,
    bytes), counting everything in a folder it leaves out, which it doesn't look inside, from the tree kopia lists in
    one go for file types."""
    key = (obj, line)
    if key in rule_drops_cache:
        return rule_drops_cache[key]
    _, dir_only, regex = parse_ignore_rule(line)
    file_types.get(obj)
    folders = files = size = 0
    stack = [(obj, '')]
    while stack:
        here, prefix = stack.pop()
        entries = file_types.entries(here) or {'f': [], 'd': []}
        if not dir_only:
            for name, nbytes in entries['f']:
                if regex.fullmatch(prefix + name):
                    files += 1
                    size += nbytes or 0
        for name, child in entries['d']:
            if regex.fullmatch(prefix + name):
                tally = file_types.get(child) or {}
                folders += 1
                files += sum(n for n, _ in tally.values())
                size += sum(b for _, b in tally.values())
            else:
                stack.append((child, f'{prefix}{name}/'))
    rule_drops_cache[key] = found = (folders, files, size)
    return found


def check_ignore_rules(path, rules):
    """What each of some ignore rules would leave out of the latest snapshots, by rule: for a folder's .kopiaignore,
    of the folder in its location's latest snapshot, and for the global policy (path None), of the latest snapshot of
    every location going by its rules, from the top of each. Each is its folders, files and bytes, and how many
    locations; None for a rule that only brings things back, or doesn't parse, or with nothing to check it against.
    Only what's in the snapshots can be counted, so a rule leaving out what's already left out finds nothing."""
    if path is None:
        policies = repository.policies()
        trees = [(snap['rootEntry']['obj'], source) for source in sorted(repository.sources)
                 if first_files_setting(policy_chain(source), policies, 'ignore')[1] in (None, 'the global policy')
                 and (snap := latest_complete(source))]
    else:
        location = ignore_location(path)
        snap = latest_complete(location)
        obj = snap and folder_in(snap['rootEntry']['obj'], Path(path).relative_to(location).parts)
        trees = [(obj, location)] if obj else []
    found = {}
    for line in rules:
        rule = parse_ignore_rule(line) if isinstance(line, str) else None
        if not rule or rule[0] or not trees:
            found[line] = None
            continue
        counts = [rule_drops(obj, line) for obj, _ in trees]
        found[line] = {'folders': sum(c[0] for c in counts), 'files': sum(c[1] for c in counts), 'bytes': sum(c[2] for c in counts),
                       'locations': sum(1 for c in counts if c[0] or c[1])}
    return found


def set_ignore_file(path, content):
    """Write a folder's .kopiaignore, in a backup location or at its top, or delete it when there's nothing in it but
    blank lines, as kopia then has nothing to read from it. Written with Windows line endings, unless the one there
    already has Unix ones, to a temporary file first, so a full disk can't leave it half written. The explorer's
    ignore rules for every location it's in are read again next time, as they've changed. Kopia uses it from the
    next snapshot of each."""
    ignore_location(path)
    if not os.path.isdir(path):
        raise ValueError(f'There\'s no folder {path} on this PC to put {IGNORE_FILE} in')
    file = Path(path) / IGNORE_FILE
    try:
        if not content.strip():
            file.unlink(missing_ok=True)
        else:
            text = content.replace('\r\n', '\n').rstrip('\n') + '\n'
            newline = '\n' if file.exists() and b'\r\n' not in file.read_bytes() else '\r\n'
            partial = file.with_name(IGNORE_FILE + '.tmp')
            partial.write_text(text, encoding='utf-8', newline=newline)
            # Windows won't replace a file while something's reading it, so that's given a moment
            for attempt in range(5):
                try:
                    partial.replace(file)
                    break
                except PermissionError:
                    if attempt == 4:
                        partial.unlink(missing_ok=True)
                        raise
                    time.sleep(0.05 * (attempt + 1))
    except OSError as e:
        raise ValueError(f'Couldn\'t {"delete" if not content.strip() else "write"} {IGNORE_FILE} in {path}: {e.strerror}')
    for source in [s for s in repository.ignores if s == path or (path.lower() + '\\').startswith(s.rstrip('\\').lower() + '\\')]:
        repository.ignores.pop(source, None)
    return ignore_file(path)


def snapshot_actions():
    """Whether kopia runs the snapshot actions in policies here, which it only does once they're turned on in its
    config, which policies have any, and whether KopiaUI's server was started before the config last changed, so
    it may still be going by what it said before, as it only reads it when it starts. Enabled is None if the
    config can't be read."""
    config = kopia_config()
    try:
        enabled = bool(json.loads(config.read_text(encoding='utf-8')).get('enableActions'))
        changed = config.stat().st_mtime
    except (OSError, ValueError):
        enabled = changed = None
    if repository.actions is None:
        repository.actions = with_actions(repository.policies())
    try:
        running = processes()
    except OSError:
        running = []
    server = kopia_ui_server(running)
    since = server and started(server)
    return {'enabled': enabled, 'policies': repository.actions, 'config': str(config),
            'kopiaUIBehind': bool(since and changed and since < changed)}


def set_actions(enabled):
    """Turn snapshot actions on or off in kopia's config, as KopiaUI has no setting for it. Written to a temporary
    file first, so it can't be left half written."""
    config = kopia_config()
    settings = json.loads(config.read_text(encoding='utf-8'))
    settings['enableActions'] = enabled
    partial = config.with_name(config.name + '.tmp')
    partial.write_text(json.dumps(settings, indent=2) + '\n', encoding='utf-8')
    os.replace(partial, config)
    return snapshot_actions()


# The task only kopia's full maintenance runs, every time, so its last run is when that last ran
FULL_MAINTENANCE_TASK = 'snapshot-gc'


def maintenance_time(timestamp):
    """A Unix time from one of kopia's maintenance timestamps, which have up to 9 fractional digits, and are in UTC
    or have the offset of where they were run"""
    return datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', timestamp)).timestamp()


def maintenance():
    """Kopia's maintenance, which frees the space deleted snapshots used and keeps the repository tidy: who runs it,
    as only kopia running as its owner does, and for each cycle, whether it's enabled, how often it runs, when it
    last did and when it's next due, as Unix times. Failed is each task whose latest run failed, as kopia counts a
    cycle as run once it starts, so a failing one is still put off to the next."""
    info = json.loads(kopia('maintenance', 'info', '--json'))
    schedule = info.get('schedule') or {}
    runs = schedule.get('runs') or {}
    latest = {task: max(task_runs, key=lambda r: maintenance_time(r['start'])) for task, task_runs in runs.items() if task_runs}
    last_any = max((maintenance_time(r['start']) for r in latest.values()), default=None)

    def cycle(name, next_due, last):
        settings = info.get(name) or {}
        return {'enabled': bool(settings.get('enabled')), 'interval': (settings.get('interval') or 0) / 1e9,
                'next': maintenance_time(next_due) if next_due and not next_due.startswith('0001') else None, 'last': last}

    full_run = latest.get(FULL_MAINTENANCE_TASK)
    return {
        'owner': info.get('owner') or '', 'me': f'{repository.info["user"]}@{repository.info["host"]}',
        'quick': cycle('quick', schedule.get('nextQuickMaintenance'), last_any),
        'full': cycle('full', schedule.get('nextFullMaintenance'), full_run and maintenance_time(full_run['start'])),
        'failed': sorted(({'task': task, 'when': maintenance_time(run['start']), 'error': run.get('error') or 'failed'}
                          for task, run in latest.items() if not run.get('success')), key=lambda f: f['when']),
    }


def own_maintenance():
    """Make kopia run maintenance from here, as this user on this PC, for when it's owned by one that no longer
    runs it"""
    kopia('maintenance', 'set', '--owner=me')
    return maintenance()


def pick_folder():
    """A folder to back up, picked in a folder picker, or None if cancelled."""
    def show(root):
        picked = filedialog.askdirectory(parent=root, title='Back up a folder', mustexist=True)
        return os.path.abspath(picked) if picked else None
    return {'path': dialogs.ask(show)}


def reveal(path):
    """Show something in Windows Explorer: a folder opened, or a file selected in its folder. If it's gone,
    the nearest folder above it that's still there. Only for things restored, folders mounted as drives, or
    things inside a backup location."""
    target = Path(os.path.abspath(path))
    mounted = (any(j['kind'] == 'mount' and j['state'] == 'mounted' and j['drive'] == path for j in jobs.values())
               or re.fullmatch(r'[A-Z]:\\', path) and any(m['drive'] == path for m in other_mounts()))
    if path not in restored and not mounted and not inside_location(path):
        raise PermissionError('Only things restored, mounted or in a backup location can be shown')
    if target.is_dir():
        subprocess.Popen(['explorer', str(target)])
    elif target.exists():
        subprocess.Popen(f'explorer /select,"{target}"')
    else:
        target = next(p for p in target.parents if p.is_dir())
        subprocess.Popen(['explorer', str(target)])
    return {'shown': str(target)}


# What happens to requests still going when the window's closed: the page is gone, so there's no one to answer,
# and kopia work waiting its turn is cancelled. Nothing's gone wrong, so nothing's said.
CLOSING = (ConnectionError, CancelledError)


class Handler(BaseHTTPRequestHandler):
    def handle(self):
        # Including saying something went wrong, to a page that's gone
        try:
            super().handle()
        except CLOSING:
            pass

    def do_GET(self):
        url = urlparse(self.path)
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        try:
            if url.path in ('/', '/index.html'):
                return self.send_file(PAGE_DIR / 'index.html', 'text/html; charset=utf-8')
            # The page's stylesheet and scripts, and nothing else from its folder
            if match := re.fullmatch(r'/(style\.css|js/[\w-]+\.js)', url.path):
                content_type = 'text/css' if url.path.endswith('.css') else 'text/javascript'
                if (PAGE_DIR / match[1]).is_file():
                    return self.send_file(PAGE_DIR / match[1], f'{content_type}; charset=utf-8')
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
            if url.path == '/api/types':
                # Any number of patterns to filter by, and where the folder is, for those matching folders
                match, path = parse_qs(url.query).get('match', []), query.get('in', '')
                return self.send_json(file_types.inside(query['obj'], match, path) if query.get('inside') else file_types.get(query['obj'], match, path))
            if url.path == '/api/nested-additions':
                return self.send_json(nested_additions(query['snapshot'], query.get('path', ''), parse_qs(url.query).get('nested', [])))
            if url.path == '/api/schedule':
                return self.send_json(schedule_of(query['path']))
            if url.path == '/api/schedules':
                return self.send_json(all_schedules())
            if url.path == '/api/copied-settings':
                return self.send_json(needing_settings())
            if url.path == '/api/nested-settings':
                return self.send_json(nested_settings())
            if url.path == '/api/repository-size':
                return self.send_json(repository_size())
            if url.path == '/api/jobs':
                return self.send_json(sorted(jobs.values(), key=lambda j: j['id']))
            if url.path == '/api/kopiaui':
                return self.send_json(kopia_ui())
            if url.path == '/api/global-ignore':
                return self.send_json(global_ignore())
            if url.path == '/api/docs':
                return self.send_json(kopia_doc(query['page']))
            if url.path == '/api/ignore-file':
                return self.send_json(ignore_file(query['path']))
            if url.path == '/api/actions':
                return self.send_json(snapshot_actions())
            if url.path == '/api/maintenance':
                return self.send_json(maintenance())
            if url.path == '/api/free-drives':
                return self.send_json(free_drives())
            if url.path == '/api/other-mounts':
                return self.send_json(other_mounts())
            self.send_error(404)
        except CLOSING:
            pass
        except KeyError as e:
            self.send_error(400, f'Missing or unknown {e}')
        except ValueError as e:
            self.send_error(400, str(e))
        except RuntimeError as e:
            self.send_error(502, kopia_reason(e))
        except PermissionError as e:
            self.send_error(403, str(e))
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
                return self.send_json(start_restore(body['snapshot'], body['path'], bool(body.get('folder')), body.get('nested') or []))
            if self.path == '/api/backup':
                return self.send_json(start_backup(body['source']))
            if self.path == '/api/backup/cancel':
                return self.send_json(cancel_backup(body['id']))
            if self.path == '/api/mount':
                return self.send_json(start_mount(body['snapshot'], body['path'], body['drive']))
            if self.path == '/api/unmount':
                return self.send_json(unmount(body['id']))
            if self.path == '/api/schedule':
                return self.send_json(set_schedule(body['path'], body['interval'], bool(body.get('manual')),
                                                   bool(body.get('copySettings')), body.get('keep')))
            if self.path == '/api/global-schedule':
                return self.send_json(set_global_schedule(body['interval'], body['keep']))
            if self.path == '/api/copied-settings':
                return self.send_json(start_settings(bool(body.get('undo')), body.get('paths')))
            if self.path == '/api/pick-folder':
                return self.send_json(pick_folder())
            if self.path == '/api/snapshot/delete':
                return self.send_json(start_delete(body['id']))
            if self.path == '/api/snapshot/pin':
                return self.send_json(start_pin(body['id'], body.get('add') or [], body.get('remove') or []))
            if self.path == '/api/jobs/clear':
                for job in [j for j in jobs.values() if j['finished']]:
                    del jobs[job['id']]
                return self.send_json({})
            if self.path == '/api/reveal':
                return self.send_json(reveal(body['path']))
            if self.path == '/api/kopiaui/start':
                return self.send_json(start_kopia_ui())
            if self.path == '/api/actions':
                return self.send_json(set_actions(bool(body['enabled'])))
            if self.path == '/api/maintenance/own':
                return self.send_json(own_maintenance())
            if self.path == '/api/check-ignore':
                return self.send_json(check_ignore_rules(body.get('path'), body.get('rules') or []))
            if self.path == '/api/global-ignore':
                return self.send_json(set_global_ignore(body['rules'], body.get('cacheDirs')))
            if self.path == '/api/ignore-file':
                return self.send_json(set_ignore_file(body['path'], body['content']))
            if self.path == '/api/location-actions':
                return self.send_json(set_location_actions(body['path'], body.get('before'), body.get('after')))
            if self.path == '/api/forget':
                repository.forget()
                return self.send_json({})
            self.send_error(404)
        except CLOSING:
            pass
        except KeyError as e:
            self.send_error(400, f'Missing or unknown {e}')
        except ValueError as e:
            self.send_error(400, str(e))
        except RuntimeError as e:
            self.send_error(502, kopia_reason(e))
        except PermissionError as e:
            self.send_error(403, str(e))
        except FileNotFoundError as e:
            self.send_error(404, str(e))
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
            # Refused, so say what asked, to tell where it came from
            if args[0] == 403:
                origin = self.headers.get('Origin') or self.headers.get('Referer') or 'no page'
                asker = f' - {self.command} {self.path} from {origin}, {self.headers.get("User-Agent") or "no user agent"}'
                format += asker.replace('%', '%%')
            super().log_message(format, *args)


def confirm_close():
    """Whether to close the window: straight away, unless backups are running, as closing stops them."""
    running = [jobs[job_id]['source'] for job_id in backup_processes]
    if not running:
        return True
    return dialogs.ask(lambda root: messagebox.askokcancel(
        'Kopia Explorer', f'{"A backup is" if len(running) == 1 else "Backups are"} still running ({", ".join(running)}).\n\n'
        'Closing stops it, keeping what it got through.', icon='warning', parent=root))


def show_window(url):
    """The page in a window of its own, until it's closed. Its settings, such as how charts are shown, are kept
    in Kopia Explorer in the local app data folder. The page is told when the window's minimised and brought
    back, as it isn't otherwise, so it stops checking for new snapshots and the like meanwhile."""
    import webview
    window = webview.create_window('Kopia Explorer', url, width=1500, height=950, min_size=(800, 500),
                                   background_color='#0f1216', text_select=True, zoomable=True)
    window.events.closing += confirm_close

    def minimised(value):
        try:
            window.evaluate_js(f'window.kopiaExplorerMinimised?.({json.dumps(value)})')
        except Exception:  # Not loaded yet, or closing, when there's nothing to tell
            pass
    window.events.minimized += lambda: minimised(True)
    # Brought back to how it was: maximised, if it was, or not
    window.events.restored += lambda: minimised(False)
    window.events.maximized += lambda: minimised(False)
    storage = Path(os.environ.get('LOCALAPPDATA') or Path.home()) / 'Kopia Explorer'
    webview.start(private_mode=False, storage_path=str(storage))


def main():
    parser = argparse.ArgumentParser(description='Browse Kopia snapshots in a window of their own.')
    parser.add_argument('--port', type=int, default=8765, help='port to serve on (default: 8765)')
    shown = parser.add_mutually_exclusive_group()
    shown.add_argument('--browser', action='store_true', help='open the page in a browser rather than a window')
    shown.add_argument('--no-browser', action='store_true', help="don't open the page anywhere, just serve it")
    parser.add_argument('--quiet', action='store_true', help="don't print each kopia command as it finishes, with how long it took")
    args = parser.parse_args()
    if not args.quiet:
        # Only kopia's commands, not everything else that logs at debug level, such as pywebview
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter('%(asctime)s %(message)s', '%H:%M:%S'))
        logging.getLogger('kopia').addHandler(handler)
        logging.getLogger('kopia').setLevel(logging.DEBUG)
    if not args.browser and not args.no_browser:
        try:
            import webview  # noqa: F401
        except ImportError:
            print("pywebview isn't installed (py -m pip install pywebview), so it's opening in a browser instead", flush=True)
            args.browser = True

    print('Reading the repository...', flush=True)
    repository.storage()
    threading.Thread(target=keep_copied_settings_up_to_date, daemon=True).start()
    threading.Thread(target=keep_checking_mounts, daemon=True).start()

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://localhost:{args.port}/'
    print(f'Kopia Explorer is at {url} (Ctrl+C to stop)', flush=True)
    try:
        if args.browser or args.no_browser:
            if args.browser:
                webbrowser.open(url)
            server.serve_forever()
        else:
            # The window has to be on the main thread, so the server isn't; closing the window stops it
            threading.Thread(target=server.serve_forever, daemon=True).start()
            show_window(url)
            server.shutdown()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        pool.shutdown(wait=False, cancel_futures=True)
        stats_pool.shutdown(wait=False, cancel_futures=True)
        # Backups would carry on without anything following them, so they're stopped, saving what they got through
        for job_id, process in list(backup_processes.items()):
            print(f'Cancelling the backup of {jobs[job_id]["source"]}...', flush=True)
            cancel_backup(job_id)
            try:
                process.wait(60)
            except subprocess.TimeoutExpired:
                process.kill()
        # Mounts would stay with nothing to unmount them, so they're unmounted, apart from ones found running,
        # which weren't mounted here
        for job_id, process in list(mount_processes.items()):
            print(f'Unmounting {jobs[job_id]["from"]}...', flush=True)
            unmount(job_id)
            try:
                process.wait(30)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        raise SystemExit(str(e))
