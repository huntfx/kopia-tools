"""Pages of kopia's documentation, for the kopia installed, as the explorer shows them: fetched from kopia's
repository on GitHub, at the release the kopia installed is from, and kept, so they're there offline. A copy of
each is kept in this repository too, in explorer/docs, for when one can't be fetched and hasn't been before, which
update_docs.py refreshes, so there's always one to show."""
import json
import os
import re
import urllib.request
from pathlib import Path

from snapshot_diff import kopia

# Each page by name: where it is in kopia's repository, under site/content/docs, and where kopia.io has it, which
# its links to other pages go to
DOCS = {'kopiaignore': ('Advanced/Kopiaignore', 'https://kopia.io/docs/advanced/kopiaignore/')}

# Pages fetched, kept for good, as a version's documentation never changes, somewhere that lasts
SAVED_DIR = Path(os.environ.get('LOCALAPPDATA') or Path.home()) / 'Kopia Explorer' / 'docs'
# The copies in this repository, with the version each is from in versions.json
BUNDLED_DIR = Path(__file__).parent / 'explorer' / 'docs'
BUNDLED_VERSIONS = BUNDLED_DIR / 'versions.json'

VERSION = re.compile(r'(\d+\.\d+\.\d+\S*)\s+build:\s*([0-9a-f]{7,})')
_ref = None


def kopia_version_ref():
    """Where in kopia's repository the documentation for the kopia installed is: its release's tag, like v0.23.0,
    or its commit for a build between releases, or the main branch if neither can be found out"""
    global _ref
    if _ref is None:
        try:
            found = VERSION.search(kopia('--version'))
        except (RuntimeError, OSError):
            found = None
        _ref = (f'v{found[1]}' if re.fullmatch(r'\d+\.\d+\.\d+', found[1]) else found[2]) if found else 'master'
    return _ref


def fetch(page, ref):
    """A page's markdown, as it is in kopia's repository at a tag, commit or branch. Raises OSError if it can't be
    fetched."""
    folder, _ = DOCS[page]
    url = f'https://raw.githubusercontent.com/kopia/kopia/{ref}/site/content/docs/{folder}/_index.md'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'kopia-explorer'}), timeout=20) as response:
            return response.read().decode('utf-8')
    except ValueError as e:
        raise OSError(str(e))


def write(path, text):
    """Written to a temporary file first, so a full disk can't leave half a page"""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix('.tmp')
    partial.write_text(text, encoding='utf-8')
    partial.replace(path)


def bundled_versions():
    try:
        return json.loads(BUNDLED_VERSIONS.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def kopia_doc(page):
    """A page of kopia's documentation, for the kopia installed: its title, its markdown without the header kopia's
    website is built from, the version it's for and the one wanted, and where kopia.io has it, which its links are
    from. Saved the first time it's fetched, and read from there after. If it can't be fetched, it's this
    repository's copy, which may be from another version."""
    _, site = DOCS[page]
    ref = kopia_version_ref()
    saved = SAVED_DIR / ref / f'{page}.md'
    result = {'version': ref, 'wanted': ref, 'site': site}
    try:
        text = saved.read_text(encoding='utf-8')
    except OSError:
        try:
            text = fetch(page, ref)
        except OSError:
            text = (BUNDLED_DIR / f'{page}.md').read_text(encoding='utf-8')
            result['version'] = bundled_versions().get(page, 'unknown')
        else:
            try:
                write(saved, text)
            except OSError:
                pass
    text = text.replace('\r\n', '\n')
    title = ''
    if header := re.match(r'---\n(.*?)\n---\n', text, re.S):
        text = text[header.end():]
        if found := re.search(r'^title:\s*["\']?(.*?)["\']?\s*$', header[1], re.M):
            title = found[1]
    return {**result, 'title': title, 'markdown': text}
