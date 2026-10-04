"""Pick the shots the video uses from terminal recordings and merge them into assets/term.js.

usage: python tools/extract_frames.py <recording> <frames.json>
<recording> is a key of SHOTS. A recording is a list of {t, runs: [[text, fg, bg, bold], ...] per row,
img: [top, left, rows, cols] | null}. A shot is the frame nearest a second, or [second, marker]: the first
frame at or after that second whose screen contains marker. Rows holding account or session notices are
blanked before anything is written; shots from other recordings already in term.js are kept.
"""
import json, sys, unicodedata
from pathlib import Path

SHOTS = {
    # 2026-10-04, Haiku in Temp with the three cc-mods on: iPad screenshot, then four sleeps
    'main': {
        'boot': 1.0,
        'slim': 8.2,
        'trio': 34.5,
        'shotBand': 38.0,
        'shotPane': 45.0,
        'eta2': 90.0,
        'eta3': 140.0,
        'stepsMid': 157.2,
        'stepsDone': 233.0,
    },
    # the same prompt with the three cc-mods turned off
    'plain': {'plain': 51.98},
    # the docs example that counts tool calls beside the spinner
    'counter': {'count0': 11.1, 'count1': 12.49, 'count2': 13.51, 'count3': 15.06},
    # the official blast-radius sample holding rm -rf build, then Cancel
    'blast': {'blastAsk': 13.31, 'blastPane': 16.0, 'blastDone': [19.0, 'Brewed for']},
    # Claude edits two files, then the built-in /diff pane
    'diff': {'diffSent': 26.29, 'diffPane': [26.3, 'Diff panel shown']},
    # claude plugin validate ./shot-view in a plain shell
    'validate': {'valTyped': 3.4, 'valDone': [4.0, 'Validation passed']},
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


def pick(frames, spec):
    if isinstance(spec, list):
        t, marker = spec
        return next(f for f in frames if f['t'] >= t and any(marker in ''.join(r[0] for r in row) for row in f['runs']))
    return min(frames, key=lambda x: abs(x['t'] - spec))


recording, frames = sys.argv[1], json.load(open(sys.argv[2]))
dest = Path(__file__).resolve().parent.parent / 'assets' / 'term.js'
prefix = 'window.TERM = '
shots = json.loads(dest.read_text()[len(prefix):].rstrip().rstrip(';')) if dest.exists() else {}
for name, spec in SHOTS[recording].items():
    f = pick(frames, spec)
    shots[name] = {'t': f['t'], 'img': f['img'], 'rows': [clean(r) for r in f['runs']]}
    print(f'{name:10s} t={f["t"]:7.2f} img={f["img"]}')
dest.write_text(prefix + json.dumps(shots, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(f'wrote {dest} ({dest.stat().st_size // 1024} KB)')
