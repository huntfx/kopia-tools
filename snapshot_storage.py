"""Show the repository space each kopia snapshot actually added.

Kopia deduplicates content chunks across files and snapshots, so a snapshot
only costs the chunks no earlier snapshot of the same source already stored.
"On disk" is the packed size of those chunks, after compression, encryption
and the repository's error correction (parity), which kopia already includes.

Deduplication is only counted within a source, so data shared with another
source is counted in both.

Examples:
    py snapshot_storage.py
    py snapshot_storage.py A:\\ElectricSheep
    py snapshot_storage.py A:\\ElectricSheep -n 10
"""

import argparse
import math
import os
import sys

from snapshot_diff import HEADER_COLOUR, RESET, find_snapshots, format_size, list_snapshots, snapshot_label

DIM_COLOUR = '\033[90m'
WARNING_COLOUR = '\033[93m'
# Gradient for the amounts each snapshot added, from the smallest (green) to the largest (red)
GRADIENT = ((90, 200, 120), (230, 210, 90), (240, 90, 80))
# Jumps between neighbouring amounts bigger than this (in powers of 10, so about 3x) are
# shrunk to this scale beyond it, so outliers don't squash everything else into one colour
GAP_LIMIT = 0.5
GAP_SCALE = 0.1
# The scale always reaches at least this many powers of 10 below the largest amount,
# so a few similar amounts all look large rather than being spread from green to red
MIN_RANGE = 3
COLUMNS = ('Size', 'New files', 'New data', 'On disk', 'Total')


def gradient_colour(position):
    """Get the 24-bit colour code at a position from 0 to 1 along the gradient."""
    position = min(max(position, 0), 1) * (len(GRADIENT) - 1)
    i = min(int(position), len(GRADIENT) - 2)
    red, green, blue = (round(a + (b - a) * (position - i)) for a, b in zip(GRADIENT[i], GRADIENT[i + 1]))
    return f'\033[38;2;{red};{green};{blue}m'


def gradient_positions(amounts):
    """Map each amount to a position from 0 to 1 along the gradient.

    Amounts are placed on a log scale from the smallest to the largest, so
    differences show whether they span bytes or gigabytes. Large jumps between
    neighbouring amounts are shrunk, so an outlier such as the initial full backup
    is still the reddest without pushing the rest to the bottom. Equal amounts
    always get the same position.
    """
    if not amounts:
        return {}
    logs = {math.log10(amount) for amount in amounts}
    logs = sorted(logs | {min(min(logs), max(logs) - MIN_RANGE)})
    scaled = {logs[0]: 0}
    for previous, current in zip(logs, logs[1:]):
        gap = current - previous
        if gap > GAP_LIMIT:
            gap = GAP_LIMIT + (gap - GAP_LIMIT) * GAP_SCALE
        scaled[current] = scaled[previous] + gap
    end = scaled[logs[-1]]
    return {amount: scaled[math.log10(amount)] / end if end else 0.5 for amount in amounts}


def print_source(source, snapshots, count, use_colour):
    def colour(text, code):
        return f'{code}{text}{RESET}' if use_colour else text

    snapshots.sort(key=lambda s: s['startTime'])
    # Stats are computed over every snapshot, as each depends on those before it.
    # Snapshots still in progress are included in kopia's stats, so they're shown
    # separately with what they've stored so far, to keep the totals adding up.
    complete = [snap for snap in snapshots if not snap.get('incomplete')]
    in_progress = [snap for snap in snapshots if snap.get('incomplete')]
    shown = complete[-count:] if count else complete
    label_width = len(snapshot_label(snapshots[0]))
    print(colour(f'Source: {source}', HEADER_COLOUR))
    print(colour(f'  {"Snapshot":<{label_width}}' + ''.join(f'{c:>11}' for c in COLUMNS), HEADER_COLOUR))

    # Colour the amounts each snapshot added relative to the others shown
    positions = gradient_positions([new[key] for snap in shown + in_progress
                                    for key in ('originalContentBytes', 'packedContentBytes')
                                    if (new := snap['storageStats']['newData'])[key]])

    def size_cell(size, graded=False):
        text = format_size(size)
        if graded and size:
            text = f'{" " * (11 - len(text))}{colour(text, gradient_colour(positions[size]))}'
        return f'{text:>11}'

    def print_row(snap):
        new = snap['storageStats']['newData']
        # Snapshots that added nothing are dimmed as a whole instead
        dim = not new['packedContentBytes']
        # Kopia only records the size of a snapshot once it completes
        size = f'{"partial":>11}' if snap.get('incomplete') else size_cell(snap['stats']['totalSize'])
        line = (f'  {snapshot_label(snap)}'
                + size
                + f'{new["fileObjects"]:>11,}'
                + size_cell(new['originalContentBytes'], graded=not dim)
                + size_cell(new['packedContentBytes'], graded=not dim)
                + size_cell(snap['storageStats']['runningTotal']['packedContentBytes']))
        print(colour(line, DIM_COLOUR) if dim else line)

    for snap in shown:
        print_row(snap)
    if in_progress:
        print(colour('  In progress (partial, stored so far):', WARNING_COLOUR))
        for snap in in_progress:
            print_row(snap)
    print()


def main():
    parser = argparse.ArgumentParser(description='Show the repository space each kopia snapshot actually added.')
    parser.add_argument('path', nargs='?', help='folder inside a snapshot source (default: every source)')
    parser.add_argument('-n', '--count', type=int, help='only show the latest N snapshots of each source')
    parser.add_argument('--no-colour', action='store_true', help='disable coloured output')
    args = parser.parse_args()

    if args.count is not None and args.count < 1:
        parser.error('--count must be at least 1')

    use_colour = sys.stdout.isatty() and not args.no_colour
    if use_colour or sys.stderr.isatty():
        os.system('')  # Enables ANSI escape codes in the Windows console

    if args.path:
        target = os.path.abspath(args.path)
        source, _ = find_snapshots(target)
        if os.path.normcase(target) != os.path.normcase(source):
            warning = (f'Warning: {target} is inside the backup location {source}.\n'
                       'Kopia only calculates storage per location, so use the location itself:\n'
                       f'    {os.path.basename(sys.argv[0])} "{source}"')
            raise SystemExit(f'{WARNING_COLOUR}{warning}{RESET}' if sys.stderr.isatty() and not args.no_colour
                             else warning)
        # Kopia also lists the snapshots of sources above this one, so keep just this source
        snapshots = [snap for snap in list_snapshots(source, '--storage-stats', include_incomplete=True)
                     if snap['source']['path'] == source]
    else:
        snapshots = list_snapshots('--storage-stats', include_incomplete=True)

    sources = {}
    for snap in snapshots:
        sources.setdefault(snap['source']['path'], []).append(snap)

    for source, source_snapshots in sources.items():
        print_source(source, source_snapshots, args.count, use_colour)

    print('New data: unique content added, before compression.')
    print('On disk:  space that content takes in the repository, including compression and parity.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        raise SystemExit(str(e))
    except KeyboardInterrupt:
        raise SystemExit(130)
