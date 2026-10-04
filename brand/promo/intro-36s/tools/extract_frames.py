"""Pick the shots the video uses from a terminal recording and write assets/term.js.

usage: python tools/extract_frames.py <recording frames.json>
The recording is a list of {t, runs: [[text, fg, bg, bold], ...] per row, img: [top, left, rows, cols] | null}.
Rows holding account or session notices are blanked before anything is written.
"""
import json, sys, unicodedata
from pathlib import Path

SHOTS = {  # name: recording second
    'boot': 1.0,
    'slim': 8.2,
    'trio': 34.5,
    'shotBand': 38.0,
    'shotPane': 45.0,
    'eta2': 90.0,
    'eta3': 140.0,
    'stepsMid': 157.2,
    'stepsDone': 233.0,
}
REDACT = ('weekly limit', 'usage limit', 'Transcript saving is off', 'login expires', '/login', 'CLAUDE_CODE_')


def clean(runs):
    """Row -> segments [text, cells, fg, bg, bold]: a run of narrow chars, or one wide (CJK) char."""
    text = ''.join(r[0] for r in runs)
    if any(k in text for k in REDACT):
        return []
    out = []
    for t, fg, bg, bold in runs:
        for ch in t:
            wide = unicodedata.east_asian_width(ch) in ('W', 'F')
            style = [fg, bg, 1 if bold else 0]
            last = out[-1] if out else None
            # narrow chars of one style share a segment; a wide char always stands alone
            if not wide and last and last[1] == len(last[0]) and last[2:] == style:
                last[0] += ch
                last[1] += 1
            else:
                out.append([ch, 2 if wide else 1, *style])
    while out and out[-1][0].strip() == '' and out[-1][3] in ('default', None):
        out.pop()
    return out


frames = json.load(open(sys.argv[1]))
shots = {}
for name, t in SHOTS.items():
    f = min(frames, key=lambda x: abs(x['t'] - t))
    shots[name] = {'t': f['t'], 'img': f['img'], 'rows': [clean(r) for r in f['runs']]}
    print(f'{name:10s} t={f["t"]:7.2f} img={f["img"]}')
dest = Path(__file__).resolve().parent.parent / 'assets' / 'term.js'
dest.write_text('window.TERM = ' + json.dumps(shots, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(f'wrote {dest} ({dest.stat().st_size // 1024} KB)')
