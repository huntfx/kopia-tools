"""List file changes between kopia snapshots of a folder or file.

Examples:
    py snapshot_diff.py A:\\ElectricSheep\\xml
    py snapshot_diff.py A:\\ElectricSheep -n 5
    py snapshot_diff.py A:\\ElectricSheep -n 5 --group
    py snapshot_diff.py 6351d2d2 149d9d24
    py snapshot_diff.py 149d9d24
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

# Snapshot IDs are 32 hex characters, but the start of one is enough if it's unique
SNAPSHOT_ID = re.compile(r'^[0-9a-fA-F]{6,32}$')


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


def glob_to_regex(pattern):
    """Convert a gitignore-style glob to a regex."""
    out = []
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if pattern.startswith('**/', i):
            out.append('(?:.*/)?')
            i += 3
        elif pattern.startswith('**', i):
            out.append('.*')
            i += 2
        elif char == '*':
            out.append('[^/]*')
            i += 1
        elif char == '?':
            out.append('[^/]')
            i += 1
        elif char == '[' and (end := pattern.find(']', i + 2)) != -1:
            body = pattern[i + 1:end].replace('\\', '\\\\')
            out.append('[' + ('^' + body[1:] if body.startswith('!') else body) + ']')
            i = end + 1
        elif char == '\\' and i + 1 < len(pattern):
            out.append(re.escape(pattern[i + 1]))
            i += 2
        else:
            out.append(re.escape(char))
            i += 1
    return ''.join(out)


def parse_ignore_rule(line):
    """Parse a gitignore-style line into (negate, dir_only, regex), or None if it has no rule."""
    line = re.sub(r'(?<!\\)\s+$', '', line)
    if not line or line.startswith('#'):
        return None
    negate = line.startswith('!')
    line = line.removeprefix('!')
    dir_only = line.endswith('/')
    line = line.rstrip('/')
    # A slash anywhere but the end anchors the pattern to the rule's directory
    regex = glob_to_regex(line.lstrip('/'))
    if '/' not in line:
        regex = '(?:.*/)?' + regex
    # Kopia matches case-sensitively, even on Windows
    return negate, dir_only, re.compile(regex)


class KopiaIgnore:
    """Matches paths against kopia's ignore rules: the policy's, plus the ignore files on disk."""

    def __init__(self, source, policy):
        """policy is a future for the source's policy JSON, so it can load in the background."""
        self.source = source
        self._policy = policy
        self._rules = {}
        self._dirs = {}

    def _load(self, dir_parts):
        """Get the rules that apply from a directory, as (negate, dir_only, regex)."""
        key = tuple(dir_parts)
        if key not in self._rules:
            files = self._policy.result().get('files', {})
            # Policy rules apply from the source root, before its ignore files
            lines = [] if dir_parts else list(files.get('ignore') or [])
            for name in files.get('ignoreDotFiles') or []:
                try:
                    with open(os.path.join(self.source, *dir_parts, name), encoding='utf-8-sig') as f:
                        lines += f.read().splitlines()
                except OSError:
                    pass
            self._rules[key] = [rule for rule in map(parse_ignore_rule, lines) if rule is not None]
        return self._rules[key]

    def ignored(self, parts, is_dir):
        """Check if a path below the source root is ignored, either directly or by a parent directory."""
        parts = tuple(parts)
        return bool(parts) and (self._dir_ignored(parts[:-1]) or self._matches(parts, is_dir))

    def _dir_ignored(self, parts):
        # Cached, as most paths share their parent directories
        if parts not in self._dirs:
            self._dirs[parts] = self.ignored(parts, True)
        return self._dirs[parts]

    def _matches(self, parts, is_dir):
        """Check the rules against the path itself, where the last matching rule wins."""
        matched = False
        # Rules in deeper ignore files come later, so take precedence
        for i in range(len(parts)):
            path = '/'.join(parts[i:])
            for negate, dir_only, regex in self._load(parts[:i]):
                if (is_dir or not dir_only) and regex.fullmatch(path):
                    matched = not negate
        return matched


def diff_snapshots(old_snap, new_snap, parts, start, is_ignored=None):
    """Diff the target between two snapshots.

    parts is the target's path below the snapshot root. The diff starts at
    parts[:start] and moves up a level whenever kopia can't diff there, which
    happens when the path is missing from either snapshot or is a file.
    Returns changes as (kind, path, old_entry, new_entry), with paths relative
    to the target. Directory paths end with a slash, the target directory
    itself is './' and a target file is ''. Removals are skipped where
    is_ignored(path, is_dir) is true for the path relative to the target.
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

    def skip(kind, path, is_dir):
        return path is None or kind == REMOVED and is_ignored is not None and is_ignored(path, is_dir)

    changes = []
    dirs = {}
    for line in output.splitlines():
        if match := DIFF_FILE.match(line):
            kind, path, size = match.groups()
            entry = {'type': 'f', 'size': int(size)}
            if not skip(kind, path := relative(path), False):
                changes.append((kind, path, entry if kind == REMOVED else None, entry if kind == ADDED else None))
        elif match := DIFF_DIR.match(line):
            kind, path = match.groups()
            entry = {'type': 'd', 'summ': {'size': 0, 'files': 0}}
            if not skip(kind, path := relative(path), True):
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


def is_snapshot_id(arg):
    return SNAPSHOT_ID.match(arg) is not None and not os.path.exists(arg)


def find_snapshots_by_id(prefixes):
    """Find the snapshots matching the ID prefixes.

    Returns their source, the source's snapshots sorted oldest first, and the
    positions of the matched snapshots in that list, also oldest first.
    """
    snapshots = json.loads(kopia('snapshot', 'list', '--json'))
    found = []
    for prefix in prefixes:
        matches = [s for s in snapshots if s['id'].startswith(prefix.lower())]
        if not matches:
            raise SystemExit(f'No snapshot ID starts with {prefix}')
        if len(matches) > 1:
            raise SystemExit(f'More than one snapshot ID starts with {prefix}, so give more of it')
        found.append(matches[0])

    source = found[0]['source']['path']
    if any(snap['source']['path'] != source for snap in found):
        raise SystemExit('The snapshots are from different sources: '
                         + ', '.join(snap['source']['path'] for snap in found))

    matched = sorted((s for s in snapshots if s['source']['path'] == source), key=lambda s: s['startTime'])
    return source, matched, sorted(matched.index(snap) for snap in found)


def main():
    parser = argparse.ArgumentParser(description='List files added, removed and modified between kopia snapshots.')
    parser.add_argument('targets', nargs='+', metavar='path_or_id',
                        help='folder or file inside a snapshot source (need not exist locally), '
                             'or one or two snapshot IDs (or the start of them)')
    parser.add_argument('-n', '--count', type=int,
                        help='number of snapshots to go back from the latest, or from the given snapshot (default: 1)')
    parser.add_argument('-a', '--all', action='store_true', help='go back through every snapshot')
    parser.add_argument('-g', '--group', action='store_true',
                        help='combine all changes into a single net result per file')
    parser.add_argument('-t', '--transient', action='store_true',
                        help='with --group, also show files that only existed between the first and last snapshot')
    parser.add_argument('--show-ignored', action='store_true',
                        help="show removals matched by kopia's current ignore rules (policy and .kopiaignore), "
                             'which are hidden by default as the files were most likely ignored, not deleted')
    parser.add_argument('-j', '--jobs', type=int, default=8, help='parallel kopia calls (default: 8)')
    parser.add_argument('--no-colour', action='store_true', help='disable coloured output')
    args = parser.parse_args()

    if args.count is not None and args.count < 1:
        parser.error('--count must be at least 1')

    ids = [t for t in args.targets if is_snapshot_id(t)]
    if len(args.targets) > 2 or ids and len(ids) != len(args.targets) or not ids and len(args.targets) > 1:
        parser.error('give either one path, or one or two snapshot IDs')

    if ids:
        source, snapshots, positions = find_snapshots_by_id(ids)
        target = source
        if len(ids) == 2:
            if args.count is not None or args.all:
                parser.error('--count and --all only apply to a single snapshot ID')
            first, last = positions
            if first == last:
                raise SystemExit('Both IDs are the same snapshot')
        else:
            last = positions[0]
            if last == 0:
                raise SystemExit(f'{ids[0]} is the oldest snapshot of {source}, so there is nothing to compare it with')
            first = 0 if args.all else max(0, last - (args.count or 1))
        snapshots = snapshots[first:last + 1]
        count = len(snapshots) - 1

    else:
        # Kopia paths are case-sensitive, so take the real case from disk where the path exists
        target = os.path.abspath(args.targets[0])
        real = os.path.realpath(target)
        if os.path.normcase(real) == os.path.normcase(target):
            target = real

        source, snapshots = find_snapshots(target)
        if len(snapshots) < 2:
            raise SystemExit(f'Source {source} has fewer than 2 snapshots')

        count = len(snapshots) - 1 if args.all else min(args.count or 1, len(snapshots) - 1)
        snapshots = snapshots[-(count + 1):]

    rel = os.path.relpath(target, source)
    parts = [] if rel == '.' else rel.split(os.sep)
    # kopia diff only compares directories, so start a file's diff at its parent
    start = len(parts) - 1 if os.path.isfile(target) else len(parts)

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        is_ignored = None
        if not args.show_ignored:
            # Hide files removed because they're now ignored rather than deleted.
            # The policy is submitted first, so it runs before any diff can wait on it.
            policy = pool.submit(lambda: json.loads(kopia('policy', 'show', source, '--json')))
            ignore = KopiaIgnore(source, policy)
            is_ignored = lambda path, is_dir: ignore.ignored(parts + (path.split('/') if path else []), is_dir)

        change_lists = list(pool.map(lambda i: diff_snapshots(snapshots[i], snapshots[i + 1], parts, start, is_ignored),
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
