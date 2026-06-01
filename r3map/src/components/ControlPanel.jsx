import { useState } from 'react';

/* ─────────────────────────────────────────────
   ControlPanel
   Props:
     livePos            string   "lat, lon"
     dir                string   "0.xx"
     poiHTML            string   raw HTML from fmtFull / fmtHover
     showSuspected      boolean
     onShowSuspectedChange(bool)
     onGoto(query)  → Promise<{displayName}> | void
     onNorth()
     onPOIView()
     onWideView()
───────────────────────────────────────────── */
export default function ControlPanel({
  livePos,
  dir,
  poiHTML,
  showSuspected,
  onShowSuspectedChange,
  onGoto,
  onNorth,
  onPOIView,
  onWideView,
}) {
  const [locValue,  setLocValue]  = useState('');
  const [gotoState, setGotoState] = useState('idle'); // idle | loading | error | ok

  const handleGoto = async () => {
    const q = locValue.trim();
    if (!q || gotoState === 'loading') return;
    setGotoState('loading');
    try {
      const result = await onGoto(q);
      if (result?.displayName) setLocValue(result.displayName);
      setGotoState('idle');
    } catch {
      setGotoState('error');
      setTimeout(() => setGotoState('idle'), 1500);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleGoto(); }
  };

  const gotoLabel =
    gotoState === 'loading' ? '…' :
    gotoState === 'error'   ? '?' :
    'GO';

  return (
    <div style={s.panel}>

      {/* ── Row 1: location search + view controls ── */}
      <div style={s.row}>

        {/* coords */}
        <span style={s.coords}>{livePos || '—'}</span>

        <Divider />

        {/* search */}
        <input
          style={s.locInput}
          placeholder="search UK location…"
          value={locValue}
          onChange={e => setLocValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Btn onClick={handleGoto} disabled={gotoState === 'loading'} accent>
          {gotoLabel}
        </Btn>

        <Divider />

        {/* direction */}
        <span style={s.label}>HDG</span>
        <span style={{ ...s.coords, minWidth: 36 }}>{dir}</span>
        <Btn onClick={onNorth}>N↑</Btn>

        <Divider />

        {/* view */}
        <Btn onClick={onPOIView}>POI</Btn>
        <Btn onClick={onWideView}>WIDE</Btn>

        <Divider />

        {/* suspected toggle */}
        <label style={s.checkLabel}>
          <input
            type="checkbox"
            checked={showSuspected}
            onChange={e => onShowSuspectedChange(e.target.checked)}
            style={s.checkbox}
          />
          <span style={s.checkText}>SUSPECTED</span>
        </label>
      </div>

      {/* ── Row 2: POI info ── */}
      {poiHTML ? (
        <div style={s.poiRow}>
          <span style={s.poiMarker}>▶</span>
          <div
            style={s.poiText}
            dangerouslySetInnerHTML={{ __html: poiHTML }}
          />
        </div>
      ) : (
        <div style={s.poiRow}>
          <span style={{ ...s.poiMarker, opacity: 0.2 }}>▶</span>
          <span style={{ ...s.poiText, opacity: 0.2, fontStyle: 'italic' }}>
            no selection
          </span>
        </div>
      )}

    </div>
  );
}

/* ── small helpers ── */

function Divider() {
  return <div style={{ width: 1, height: 20, background: '#333', margin: '0 8px', flexShrink: 0 }} />;
}

function Btn({ children, onClick, disabled, accent }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...s.btn,
        ...(accent   ? s.btnAccent : {}),
        ...(hover    ? (accent ? s.btnAccentHover : s.btnHover) : {}),
        ...(disabled ? s.btnDisabled : {}),
      }}
    >
      {children}
    </button>
  );
}

/* ── styles ── */

const FONT   = "'Courier New', 'Lucida Console', monospace";
const RED    = '#ff3322';
const DIM    = '#666';
const PANEL  = '#111111';
const BORDER = '#282828';

const s = {
  panel: {
    fontFamily:     FONT,
    fontSize:       12,
    background:     PANEL,
    borderTop:      `1px solid ${BORDER}`,
    padding:        '8px 14px 10px',
    display:        'flex',
    flexDirection:  'column',
    gap:            6,
    flexShrink:     0,
    userSelect:     'none',
    letterSpacing:  '0.04em',
  },
  row: {
    display:    'flex',
    alignItems: 'center',
    gap:        6,
    flexWrap:   'wrap',
  },
  coords: {
    color:      RED,
    fontSize:   11,
    minWidth:   160,
    letterSpacing: '0.05em',
  },
  label: {
    color:      DIM,
    fontSize:   10,
    textTransform: 'uppercase',
  },
  locInput: {
    fontFamily:  FONT,
    fontSize:    11,
    background:  '#1a1a1a',
    border:      `1px solid ${BORDER}`,
    color:       '#ccc',
    padding:     '4px 8px',
    outline:     'none',
    width:       240,
    letterSpacing: '0.03em',
  },
  btn: {
    fontFamily:     FONT,
    fontSize:       10,
    background:     '#1a1a1a',
    border:         `1px solid ${BORDER}`,
    color:          '#aaa',
    padding:        '4px 10px',
    cursor:         'pointer',
    letterSpacing:  '0.08em',
    textTransform:  'uppercase',
    transition:     'all 0.1s',
    flexShrink:     0,
  },
  btnHover: {
    background: '#222',
    color:      '#eee',
    borderColor: '#444',
  },
  btnAccent: {
    background:   '#1e0c0a',
    color:        RED,
    borderColor:  '#5a1a14',
  },
  btnAccentHover: {
    background:   '#2a100d',
    color:        '#ff5544',
    borderColor:  RED,
  },
  btnDisabled: {
    opacity: 0.4,
    cursor:  'default',
  },
  checkLabel: {
    display:    'flex',
    alignItems: 'center',
    gap:        6,
    cursor:     'pointer',
    color:      DIM,
  },
  checkbox: {
    accentColor: RED,
    cursor:      'pointer',
  },
  checkText: {
    fontSize:    10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  poiRow: {
    display:    'flex',
    alignItems: 'flex-start',
    gap:        8,
    minHeight:  18,
  },
  poiMarker: {
    color:      RED,
    fontSize:   9,
    marginTop:  2,
    flexShrink: 0,
  },
  poiText: {
    color:      '#bbb',
    fontSize:   11,
    lineHeight: '1.5',
  },
};
