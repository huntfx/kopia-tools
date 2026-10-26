"""Show the history of a file or folder across kopia snapshots.

Every snapshot source containing the path gets its own history, since sources
can overlap. Snapshots where the path is unchanged are merged into one row.

Examples:
    py snapshot_history.py "C:\\Users\\Peter\\Documents\\The Riftbreaker\\exor_logs.txt"
    py snapshot_history.py B:\\Projects\\Photos
"""

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

from snapshot_diff import (ADDED, COLOURS, HEADER_COLOUR, MODIFIED, REMOVED, RESET, SYMBOLS, diff_snapshots,
                           entry_files, entry_size, find_sources, format_size, format_time, kopia, snapshot_label)
from snapshot_storage import gradient_positions

DIM_COLOUR = '\033[90m'
# Size changes fade from white (no change) to red as something grows, or green as it shrinks
NO_CHANGE_COLOUR = (240, 240, 240)
GROWTH_COLOUR = (240, 90, 80)
SHRINK_COLOUR = (90, 200, 120)
OLDEST = 'oldest'  # Present in the oldest snapshot, so when it was added isn't known


def entry_in_snapshot(snap, parts):
    """Get the target's entry in a snapshot, or None if it isn't there."""
    if not parts:
        return snap['rootEntry']
    parent = snap['rootEntry']['obj'] + ''.join(f'/{p}' for p in parts[:-1])
    try:
        listing = json.loads(kopia('show', parent))
    except RuntimeError as e:
        if 'not found' in str(e) or 'not a directory' in str(e):
            return None
        raise
    except ValueError:
        # The parent is a file in this snapshot, so kopia showed its contents
        return None
    if listing.get('stream') != 'kopia:directory':
        return None

    entries = listing.get('entries') or []
    name = parts[-1]
    found = next((e for e in entries if e['name'] == name), None)
    if found is None:
        # Windows paths are case-insensitive, so fall back to a case-insensitive match
        found = next((e for e in entries if e['name'].casefold() == name.casefold()), None)
    return found


def build_versions(snapshots, entries):
    """Merge consecutive snapshots where the entry is unchanged into versions.

    Each version is a dict of kind, entry, first and last snapshot, and count.
    Leading snapshots without the entry are skipped.
    """
    versions = []
    for i, (snap, entry) in enumerate(zip(snapshots, entries)):
        obj = entry['obj'] if entry else None
        if versions and obj == (versions[-1]['entry'] or {}).get('obj'):
            versions[-1]['last'] = snap
            versions[-1]['count'] += 1
            continue
        if entry is None and not versions:
            continue
        if entry is None:
            kind = REMOVED
        elif not versions or versions[-1]['entry'] is None:
            kind = OLDEST if i == 0 else ADDED
        else:
            kind = MODIFIED
        versions.append({'kind': kind, 'entry': entry, 'first': snap, 'last': snap, 'count': 1})
    return versions


def change_colour(amount, positions):
    """Get the colour for a size change: white for none, fading to red for growth or green for shrinking."""
    end = GROWTH_COLOUR if amount > 0 else SHRINK_COLOUR
    position = positions[abs(amount)]
    red, green, blue = (round(a + (b - a) * position) for a, b in zip(NO_CHANGE_COLOUR, end))
    return f'\033[38;2;{red};{green};{blue}m'


def count_file_changes(old_snap, new_snap, parts):
    """Count the files added, removed and modified in a folder between two snapshots."""
    counts = {ADDED: 0, REMOVED: 0, MODIFIED: 0}
    for kind, _, old, new in diff_snapshots(old_snap, new_snap, list(parts), len(parts)):
        if (old or new)['type'] == 'f':
            counts[kind] += 1
    return counts


def print_history(source, snapshots, versions, use_colour):
    def colour(text, code):
        return f'{code}{text}{RESET}' if use_colour else text

    changes = sum(v['kind'] != OLDEST for v in versions)
    print(colour(f'Source: {source}', HEADER_COLOUR)
          + colour(f'   {len(snapshots)} snapshots, {changes} change{"" if changes == 1 else "s"}', DIM_COLOUR))
    if not versions:
        print('  Not in any snapshot, so it may be ignored here')
        print()
        return

    # Work out each version's size change first, so they can be coloured relative to each other.
    # Changes are against the previous version, so only shown when modified.
    previous = None
    for version in versions:
        entry = version['entry']
        version['size_change'] = 0
        if entry is not None and previous is not None and version['kind'] == MODIFIED:
            size, old_size = entry_size(entry), entry_size(previous)
            if size is not None and old_size is not None:
                version['size_change'] = size - old_size
        if entry is not None:
            previous = entry
    # Growth and shrinking share a scale, so a small change either way stays close to white
    size_positions = gradient_positions([abs(v['size_change']) for v in versions if v['size_change']])

    files_width = max((len(f'{entry_files(v["entry"]):,}') for v in versions
                       if v['entry'] and v['entry']['type'] == 'd'), default=0)
    breakdown_width = max((len(f'+{c[ADDED]:,}  -{c[REMOVED]:,}  ~{c[MODIFIED]:,}') for v in versions
                           if (c := v.get('file_changes'))), default=0)
    for version in versions:
        entry = version['entry']
        kind = version['kind']
        symbol = colour(SYMBOLS[kind], COLOURS[kind]) if kind in SYMBOLS else ' '
        line = f'  {symbol} {snapshot_label(version["first"])}'

        if entry is None:
            line += f'  {"removed":>9}'
        else:
            size = entry_size(entry)
            size_change = version['size_change']
            if size_change:
                text = f'({"+" if size_change > 0 else "-"}{format_size(abs(size_change))})'
                size_text = colour(text, change_colour(size_change, size_positions)) + ' ' * (12 - len(text))
            else:
                size_text = ' ' * 12
            line += f'  {format_size(size) if size is not None else "":>9} {size_text}'
            if entry['type'] == 'd':
                files = entry_files(entry)
                line += f'  {files:>{files_width},} {"file" if files == 1 else "files":<5}  '
                if counts := version.get('file_changes'):
                    plain = f'+{counts[ADDED]:,}  -{counts[REMOVED]:,}  ~{counts[MODIFIED]:,}'
                    line += ('  '.join(colour(f'{SYMBOLS[k]}{counts[k]:,}', COLOURS[k])
                                       for k in (ADDED, REMOVED, MODIFIED))
                             + ' ' * (breakdown_width - len(plain)))
                else:
                    line += ' ' * breakdown_width
            else:
                line += f'  modified {format_time(entry["mtime"])}'

        if version['count'] > 1:
            line += colour(f'  ({version["count"]} snapshots, until {format_time(version["last"]["startTime"])})',
                           DIM_COLOUR)
        print(line.rstrip())
    print()


def main():
    parser = argparse.ArgumentParser(description='Show the history of a file or folder across kopia snapshots.')
    parser.add_argument('path', help='file or folder inside one or more snapshot sources (need not exist locally)')
    parser.add_argument('-j', '--jobs', type=int, default=8, help='parallel kopia calls (default: 8)')
    parser.add_argument('--no-colour', action='store_true', help='disable coloured output')
    args = parser.parse_args()

    # Kopia paths are case-sensitive, so take the real case from disk where the path exists
    target = os.path.abspath(args.path)
    real = os.path.realpath(target)
    if os.path.normcase(real) == os.path.normcase(target):
        target = real

    sources = find_sources(target)
    if not sources:
        raise SystemExit(f'No snapshot source contains {target}')

    # Look up each distinct snapshot root once, as unchanged snapshots share the same root
    lookups = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for source, snapshots in sources:
            rel = os.path.relpath(target, source)
            parts = [] if rel == '.' else rel.split(os.sep)
            for snap in snapshots:
                key = (snap['rootEntry']['obj'], tuple(parts))
                if key not in lookups:
                    lookups[key] = pool.submit(entry_in_snapshot, snap, parts)

    # For folders that changed, diff each change to count the files added, removed and modified
    histories = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for source, snapshots in sources:
            rel = os.path.relpath(target, source)
            parts = tuple([] if rel == '.' else rel.split(os.sep))
            entries = [lookups[snap['rootEntry']['obj'], parts].result() for snap in snapshots]
            versions = build_versions(snapshots, entries)
            for previous, version in zip(versions, versions[1:]):
                if version['kind'] == MODIFIED and version['entry']['type'] == 'd':
                    version['file_changes'] = pool.submit(count_file_changes, previous['last'], version['first'], parts)
            histories.append((source, snapshots, versions))
    for _, _, versions in histories:
        for version in versions:
            if 'file_changes' in version:
                version['file_changes'] = version['file_changes'].result()

    use_colour = sys.stdout.isatty() and not args.no_colour
    if use_colour:
        os.system('')  # Enables ANSI escape codes in the Windows console

    print(f'Target: {target}')
    print()
    for source, snapshots, versions in histories:
        print_history(source, snapshots, versions, use_colour)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        raise SystemExit(str(e))
    except KeyboardInterrupt:
        raise SystemExit(130)
