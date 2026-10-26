"""List file changes between kopia snapshots of a folder or file.

Examples:
    py snapshot_diff.py A:\\ElectricSheep\\xml
    py snapshot_diff.py A:\\ElectricSheep -n 5
    py snapshot_diff.py A:\\ElectricSheep -n 5 --group
"""

import argparse
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

ADDED = 'added'
REMOVED = 'removed'
MODIFIED = 'modified'
TRANSIENT = 'transient'  # Grouped only: absent in first and last snapshot, but present in between

SYMBOLS = {ADDED: '+', REMOVED: '-', MODIFIED: '~', TRANSIENT: '*'}
COLOURS = {ADDED: '\033[32m', REMOVED: '\033[31m', MODIFIED: '\033[33m', TRANSIENT: '\033[35m'}
HEADER_COLOUR = '\033[96m'
RESET = '\033[0m'

# Lines of `kopia diff` output that we use; the rest is metadata-only differences
DIFF_FILE = re.compile(r'^(added|removed) file \./(.*) \((\d+) bytes\)$')
DIFF_DIR = re.compile(r'^(added|removed) directory \./(.*)$')
DIFF_CHANGED = re.compile(r'^changed \./(.*) at \d{4}-\d\d-\d\d .* \(size (\d+) -> (\d+)\)$')


def kopia(*args):
    """Run a kopia command and return its output."""
    result = subprocess.run(['kopia', *args], capture_output=True, text=True, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(f'kopia {" ".join(args)} failed:\n{result.stderr.strip()}')
    return result.stdout


def find_snapshots(target):
    """Find the snapshot source containing target, and its snapshots sorted oldest first."""
    snapshots = json.loads(kopia('snapshot', 'list', '--json'))
    norm_target = os.path.normcase(target)

    best = None
    for snap in snapshots:
        source = snap['source']['path']
        norm_source = os.path.normcase(source)
        if norm_target == norm_source or norm_target.startswith(norm_source.rstrip(os.sep) + os.sep):
            if best is None or len(source) > len(best):
                best = source
    if best is None:
        raise SystemExit(f'No snapshot source contains {target}')

    matched = [s for s in snapshots if s['source']['path'] == best]
    matched.sort(key=lambda s: s['startTime'])
    return best, matched


def diff_snapshots(old_snap, new_snap, parts, start):
    """Diff the target between two snapshots.

    parts is the target's path below the snapshot root. The diff starts at
    parts[:start] and moves up a level whenever kopia can't diff there, which
    happens when the path is missing from either snapshot or is a file.
    Returns changes as (kind, path, old_entry, new_entry), with paths relative
    to the target. Directory paths end with a slash, the target directory
    itself is './' and a target file is ''.
    """
    for level in range(start, -1, -1):
        sub = ''.join(f'/{p}' for p in parts[:level])
        try:
            output = kopia('diff', old_snap['rootEntry']['obj'] + sub, new_snap['rootEntry']['obj'] + sub)
            break
        except RuntimeError:
            if level == 0:
                raise
    prefix = '/'.join(parts[level:])

    def relative(path):
        """Return path relative to the target, or None if it's outside it."""
        if not prefix:
            return path
        if path == prefix:
            return ''
        if path.startswith(prefix + '/'):
            return path[len(prefix) + 1:]
        return None

    changes = []
    dirs = {}
    for line in output.splitlines():
        if match := DIFF_FILE.match(line):
            kind, path, size = match.groups()
            entry = {'type': 'f', 'size': int(size)}
            if (path := relative(path)) is not None:
                changes.append((kind, path, entry if kind == REMOVED else None, entry if kind == ADDED else None))
        elif match := DIFF_DIR.match(line):
            kind, path = match.groups()
            entry = {'type': 'd', 'summ': {'size': 0, 'files': 0}}
            if (path := relative(path)) is not None:
                dirs[kind, path] = entry
                changes.append((kind, f'{path}/' if path else './', None if kind == ADDED else entry,
                                entry if kind == ADDED else None))
        elif match := DIFF_CHANGED.match(line):
            path, old_size, new_size = match.groups()
            if (path := relative(path)) is not None:
                changes.append((MODIFIED, path, {'type': 'f', 'size': int(old_size)},
                                {'type': 'f', 'size': int(new_size)}))

    # Total up each wholly added/removed directory from the files listed inside it
    for kind, path, old, new in changes:
        entry = old or new
        if kind != MODIFIED and entry['type'] == 'f':
            segments = path.split('/')
            for i in range(len(segments)):
                parent = dirs.get((kind, '/'.join(segments[:i])))
                if parent is not None:
                    parent['summ']['size'] += entry['size']
                    parent['summ']['files'] += 1

    changes.sort(key=lambda c: c[1].casefold())
    return changes


def group_changes(change_lists, include_transient):
    """Fold per-step changes into one net change per path.

    Whether a file exists in the first and last snapshot decides the result:
    existed in both and changed at any point is modified, even if it was
    deleted and restored with identical content. Files that existed in
    neither are transient, and are left out unless include_transient is set.
    """
    history = {}
    for changes in change_lists:
        for kind, path, old, new in changes:
            item = history.setdefault(path, {'first': kind, 'last': kind, 'old': old, 'new': new, 'seen': None})
            item['last'] = kind
            item['new'] = new
            item['seen'] = new or item['seen']

    grouped = []
    for path, item in history.items():
        existed_first = item['first'] != ADDED
        exists_last = item['last'] != REMOVED
        old = item['old'] if existed_first else None
        new = item['new'] if exists_last else None
        if existed_first and exists_last:
            kind = MODIFIED
        elif exists_last:
            kind = ADDED
        elif existed_first:
            kind = REMOVED
        elif not include_transient:
            continue
        else:
            # Exists in neither snapshot, so show the last version that existed in between
            kind = TRANSIENT
            new = item['seen']
        grouped.append((kind, path, old, new))
    grouped.sort(key=lambda c: c[1].casefold())
    return grouped


def collapse_dirs(changes):
    """Show wholly added or removed directories as a single line, hiding their contents.

    Directories that existed at both ends are dropped, since their contents show the changes.
    """
    collapsed = {path for kind, path, *_ in changes if path.endswith('/') and kind != MODIFIED}

    def inside_collapsed(path):
        if './' in collapsed and path != './':
            return True
        parts = path.rstrip('/').split('/')
        return any('/'.join(parts[:i]) + '/' in collapsed for i in range(1, len(parts)))

    return [c for c in changes if not (c[1].endswith('/') and c[0] == MODIFIED) and not inside_collapsed(c[1])]


def format_time(timestamp):
    # Kopia uses up to 9 fractional digits, which fromisoformat doesn't accept before Python 3.11
    return datetime.fromisoformat(timestamp[:19] + '+00:00').astimezone().strftime('%Y-%m-%d %H:%M')


def snapshot_label(snap):
    return f'{format_time(snap["startTime"])} ({snap["id"][:8]})'


def format_size(size):
    if size < 1000:
        return f'{size} B'
    for unit in ('KB', 'MB', 'GB', 'TB', 'PB'):
        size /= 1000
        if round(size, 1) < 1000 or unit == 'PB':
            return f'{size:.1f} {unit}'


def entry_size(entry):
    if entry['type'] == 'd':
        return entry['summ']['size']
    return entry.get('size')


def entry_files(entry):
    return entry['summ']['files'] if entry['type'] == 'd' else 1


def print_section(label, changes, target_name, use_colour):
    def colour(text, code):
        return f'{code}{text}{RESET}' if use_colour else text

    changes = collapse_dirs(changes)
    counts = {kind: 0 for kind in SYMBOLS}
    for kind, path, old, new in changes:
        counts[kind] += entry_files(new or old)
    totals = '  '.join(colour(f'{SYMBOLS[k]}{counts[k]:,}', COLOURS[k]) for k in SYMBOLS if k != TRANSIENT or counts[k])
    print(f'{colour(label, HEADER_COLOUR)}   {totals}')

    for kind, path, old, new in changes:
        entry = new or old
        size = entry_size(entry)
        symbol = colour(SYMBOLS[kind], COLOURS[kind])
        path = path or target_name
        line = f'  {symbol} {format_size(size) if size is not None else "":>9}  {path}'
        if entry['type'] == 'd':
            files = entry_files(entry)
            line += f'  ({files:,} file{"" if files == 1 else "s"})' if files else '  (empty)'
        elif kind == MODIFIED and size is not None and old.get('size') is not None and size != old['size']:
            delta = size - old['size']
            line += f'  ({"+" if delta > 0 else "-"}{format_size(abs(delta))})'
        print(line)
    if changes:
        print()


def main():
    parser = argparse.ArgumentParser(description='List files added, removed and modified between kopia snapshots.')
    parser.add_argument('path', help='folder or file inside a snapshot source (need not exist locally)')
    parser.add_argument('-n', '--count', type=int, default=1,
                        help='number of snapshots to go back from the latest (default: 1)')
    parser.add_argument('-a', '--all', action='store_true', help='go back through every snapshot')
    parser.add_argument('-g', '--group', action='store_true',
                        help='combine all changes into a single net result per file')
    parser.add_argument('-t', '--transient', action='store_true',
                        help='with --group, also show files that only existed between the first and last snapshot')
    parser.add_argument('-j', '--jobs', type=int, default=8, help='parallel kopia calls (default: 8)')
    parser.add_argument('--no-colour', action='store_true', help='disable coloured output')
    args = parser.parse_args()

    if args.count < 1:
        parser.error('--count must be at least 1')

    # Kopia paths are case-sensitive, so take the real case from disk where the path exists
    target = os.path.abspath(args.path)
    real = os.path.realpath(target)
    if os.path.normcase(real) == os.path.normcase(target):
        target = real

    source, snapshots = find_snapshots(target)
    if len(snapshots) < 2:
        raise SystemExit(f'Source {source} has fewer than 2 snapshots')

    count = len(snapshots) - 1 if args.all else min(args.count, len(snapshots) - 1)
    snapshots = snapshots[-(count + 1):]

    rel = os.path.relpath(target, source)
    parts = [] if rel == '.' else rel.split(os.sep)
    # kopia diff only compares directories, so start a file's diff at its parent
    start = len(parts) - 1 if os.path.isfile(target) else len(parts)

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        change_lists = list(pool.map(lambda i: diff_snapshots(snapshots[i], snapshots[i + 1], parts, start),
                                     range(count)))

    use_colour = sys.stdout.isatty() and not args.no_colour
    if use_colour:
        os.system('')  # Enables ANSI escape codes in the Windows console

    target_name = os.path.basename(target)
    print(f'Source: {source}')
    print(f'Target: {target}')
    print()
    if args.group:
        label = f'{snapshot_label(snapshots[0])} -> {snapshot_label(snapshots[-1])}'
        print_section(label, group_changes(change_lists, args.transient), target_name, use_colour)
    else:
        for i, changes in enumerate(change_lists):
            label = f'{snapshot_label(snapshots[i])} -> {snapshot_label(snapshots[i + 1])}'
            print_section(label, changes, target_name, use_colour)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        raise SystemExit(str(e))
    except KeyboardInterrupt:
        raise SystemExit(130)
