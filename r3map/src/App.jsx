import { useState, useRef, useCallback } from 'react';
import MapCanvas   from './components/MapCanvas';
import ControlPanel from './components/ControlPanel';

export default function App() {
  const [livePos,       setLivePos]       = useState('');
  const [dir,           setDir]           = useState('—');
  const [poiHTML,       setPOIHTML]       = useState('');
  const [showSuspected, setShowSuspected] = useState(true);

  const mapRef = useRef(null);

  /* ── imperative actions that reach into the canvas ── */

  const handleGoto = useCallback(async (query) => {
    return mapRef.current?.gotoLocation(query);
  }, []);

  const handleNorth = useCallback(() => {
    mapRef.current?.resetDirection();
  }, []);

  const handlePOIView = useCallback(() => {
    mapRef.current?.setPOIView();
  }, []);

  const handleWideView = useCallback(() => {
    mapRef.current?.setWideView();
  }, []);

  const handleShowSuspectedChange = useCallback((val) => {
    setShowSuspected(val);
    mapRef.current?.setShowSuspected(val);
  }, []);

  return (
    <div style={styles.root}>
      <MapCanvas
        ref={mapRef}
        onLivePosChange={setLivePos}
        onDirChange={setDir}
        onPOIChange={setPOIHTML}
        style={styles.canvas}
      />
      <ControlPanel
        livePos={livePos}
        dir={dir}
        poiHTML={poiHTML}
        showSuspected={showSuspected}
        onShowSuspectedChange={handleShowSuspectedChange}
        onGoto={handleGoto}
        onNorth={handleNorth}
        onPOIView={handlePOIView}
        onWideView={handleWideView}
      />
    </div>
  );
}

const styles = {
  root: {
    width:          '100vw',
    height:         '100vh',
    display:        'flex',
    flexDirection:  'column',
    background:     '#0a0a0a',
    overflow:       'hidden',
  },
  canvas: {
    flex:           1,
    minHeight:      0,
  },
};
