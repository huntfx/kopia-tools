"""Refresh the copies of kopia's documentation kept in this repository, in explorer/docs, which the explorer falls
back to when it can't fetch a page and hasn't before. Fetches every page it shows, for the kopia installed, or
another version with --ref, and notes the version each is from.

    py update_docs.py
    py update_docs.py --ref v0.24.0
"""
import argparse
import json
import sys

from kopia_docs import BUNDLED_DIR, BUNDLED_VERSIONS, DOCS, bundled_versions, fetch, kopia_version_ref, write


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ref', help='tag, commit or branch of kopia\'s repository to fetch from (default: the kopia installed)')
    ref = parser.parse_args().ref or kopia_version_ref()
    versions = bundled_versions()
    failed = False
    for page in DOCS:
        try:
            text = fetch(page, ref)
        except OSError as e:
            print(f'{page}: couldn\'t fetch it for {ref}: {getattr(e, "reason", None) or e}', file=sys.stderr)
            failed = True
            continue
        path = BUNDLED_DIR / f'{page}.md'
        changed = not path.is_file() or path.read_text(encoding='utf-8') != text
        write(path, text)
        versions[page] = ref
        print(f'{page}: {ref}{"" if changed else " (unchanged)"}')
    write(BUNDLED_VERSIONS, json.dumps(versions, indent=2, sort_keys=True) + '\n')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
