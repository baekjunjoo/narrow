#!/usr/bin/env python3
"""Compare distributed license texts with installed package/system originals."""
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LICENSES = ROOT/'client/public/licenses'


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.hrefs.append(dict(attrs).get('href'))


def main():
    originals = {
        'REACT_MIT.txt': ROOT/'node_modules/react/LICENSE',
        'REACT_DOM_MIT.txt': ROOT/'node_modules/react-dom/LICENSE',
        'GPL-3.0.txt': Path('/usr/share/common-licenses/GPL-3'),
    }
    parser = Links()
    parser.feed((LICENSES/'index.html').read_text(encoding='utf-8'))
    for name, original in originals.items():
        assert (LICENSES/name).is_file(), f'missing distributed license: {name}'
        assert (LICENSES/name).read_bytes() == original.read_bytes(), f'license differs from original: {name}'
        assert name in parser.hrefs, f'missing notice link: {name}'
        print('PASS: linked verbatim', name)


if __name__ == '__main__':
    main()
